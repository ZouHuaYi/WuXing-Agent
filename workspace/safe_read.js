import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

// 定义__dirname，因为ES模块没有这个全局变量
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * 安全读取文件函数，防止路径穿越攻击
 * @param {string} userPath - 用户提供的文件路径
 * @param {string} allowedDir - 允许访问的根目录（绝对路径）
 * @returns {Promise<string>} 文件内容
 */
async function safeReadFile(userPath, allowedDir) {
  try {
    // 解析允许的根目录为绝对路径
    const rootDir = path.resolve(allowedDir);
    
    // 解析用户路径，防止路径穿越
    const resolvedPath = path.resolve(path.join(rootDir, userPath));
    
    // 检查解析后的路径是否在允许的目录范围内
    if (!resolvedPath.startsWith(rootDir)) {
      throw new Error('路径穿越检测：访问被拒绝的路径');
    }
    
    // 解析符号链接，确保实际路径也在允许范围内
    const realPath = await fs.realpath(resolvedPath);
    if (!realPath.startsWith(rootDir)) {
      throw new Error('符号链接路径穿越检测：访问被拒绝的路径');
    }
    
    // 安全读取文件
    const content = await fs.readFile(realPath, 'utf8');
    return content;
  } catch (error) {
    throw new Error(`文件读取失败：${error.message}`);
  }
}

// 测试函数
async function testSafeRead() {
  const testDir = path.join(__dirname, 'test_files');
  
  // 创建测试目录和文件
  await fs.mkdir(testDir, { recursive: true });
  await fs.writeFile(path.join(testDir, 'safe.txt'), '这是一个安全的文件');
  
  // 测试正常读取
  try {
    const content1 = await safeReadFile('safe.txt', testDir);
    console.log('正常读取测试通过：', content1);
  } catch (e) {
    console.error('正常读取测试失败：', e.message);
  }
  
  // 测试路径穿越攻击
  try {
    await safeReadFile('../package.json', testDir);
    console.error('路径穿越测试失败：未阻止非法访问');
  } catch (e) {
    console.log('路径穿越测试通过：', e.message);
  }
  
  // 清理测试文件
  await fs.rm(testDir, { recursive: true, force: true });
}

// 执行测试
testSafeRead().catch(console.error);