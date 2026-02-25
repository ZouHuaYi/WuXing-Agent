const SQLInjectionScanner = require('./sql_scanner');
const axios = require('axios');

// 模拟测试服务器
const express = require('express');
const app = express();

// 模拟易受攻击的端点
app.get('/test', (req, res) => {
  const id = req.query.id;
  
  // 模拟MySQL错误
  if (id && id.includes(`'`)) {
    res.status(500).send("You have an error in your SQL syntax; check the manual that corresponds to your MySQL server version for the right syntax to use near '' at line 1");
    return;
  }
  
  // 模拟时间盲注
  if (id && id.includes('SLEEP(5)')) {
    setTimeout(() => {
      res.send("Delayed response");
    }, 5000);
    return;
  }
  
  // 模拟布尔盲注
  if (id && id.includes('1=1')) {
    res.send("Valid response");
    return;
  }
  
  if (id && id.includes('1=2')) {
    res.send("Invalid response");
    return;
  }
  
  res.send("Normal response");
});

// 启动测试服务器
let server;

async function startServer() {
  return new Promise((resolve) => {
    server = app.listen(3000, () => {
      console.log('测试服务器启动在 http://localhost:3000');
      resolve();
    });
  });
}

async function stopServer() {
  if (server) {
    await server.close();
    console.log('测试服务器已停止');
  }
}

// 测试用例
async function runTests() {
  console.log('\n=== 开始测试SQL注入扫描器 ===\n');
  
  await startServer();
  const scanner = new SQLInjectionScanner();
  
  try {
    // 测试错误注入检测
    console.log('测试1: 基于错误的SQL注入检测');
    const errorResult = await scanner.detectErrorBased('http://localhost:3000/test', 'id', '1');
    console.log(`结果: ${errorResult.vulnerable ? '发现漏洞' : '未发现漏洞'}`);
    if (errorResult.vulnerable) {
      console.log(`  类型: ${errorResult.injectionType}`);
      console.log(`  数据库: ${errorResult.dbType}`);
    }
    console.log();

    // 测试时间盲注检测
    console.log('测试2: 时间盲注检测');
    const timeResult = await scanner.detectTimeBlind('http://localhost:3000/test', 'id', '1');
    console.log(`结果: ${timeResult.vulnerable ? '发现漏洞' : '未发现漏洞'}`);
    if (timeResult.vulnerable) {
      console.log(`  类型: ${timeResult.injectionType}`);
      console.log(`  数据库: ${timeResult.dbType}`);
    }
    console.log();

    // 测试布尔盲注检测
    console.log('测试3: 布尔盲注检测');
    const boolResult = await scanner.detectBooleanBlind('http://localhost:3000/test', 'id', '1');
    console.log(`结果: ${boolResult.vulnerable ? '发现漏洞' : '未发现漏洞'}`);
    if (boolResult.vulnerable) {
      console.log(`  类型: ${boolResult.injectionType}`);
      console.log(`  数据库: ${boolResult.dbType}`);
    }
    console.log();

    // 测试完整扫描
    console.log('测试4: 完整URL扫描');
    const fullResults = await scanner.scanUrl('http://localhost:3000/test?id=1&name=test');
    console.log(`扫描完成，发现 ${fullResults.length} 个漏洞`);
    fullResults.forEach((result, index) => {
      console.log(`  ${index + 1}. 参数: ${result.parameter}, 类型: ${result.injectionType}, 数据库: ${result.dbType}`);
    });
    
  } catch (error) {
    console.error('测试出错:', error.message);
  } finally {
    await stopServer();
    console.log('\n=== 测试完成 ===');
  }
}

runTests();