import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import os from 'os';

async function handler(args) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    
    // 设置输出路径
    const outputPath = path.join(process.cwd(), args.filename || 'output.pdf');
    const writeStream = fs.createWriteStream(outputPath);
    doc.pipe(writeStream);
    
    // 添加中文字体支持
    let fontPath;
    if (os.platform() === 'win32') {
      fontPath = 'C:/Windows/Fonts/simsun.ttc'; // Windows 宋体
    } else if (os.platform() === 'darwin') {
      fontPath = '/Library/Fonts/Songti.ttc'; // macOS 宋体
    } else {
      fontPath = '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc'; // Linux 文泉驿微米黑
    }
    
    try {
      if (fs.existsSync(fontPath)) {
        doc.font(fontPath);
      } else {
        // 如果系统字体不存在，使用PDFKit默认字体并启用Unicode支持
        doc.font('Helvetica').fontSize(12);
      }
    } catch (err) {
      console.warn('无法加载中文字体，使用默认字体:', err.message);
    }
    
    // 添加标题
    doc.fontSize(24).text(args.title || 'PDF 文档', { align: 'center' });
    doc.moveDown();
    
    // 添加内容（支持中文）
    doc.fontSize(12).text(args.content || '这是一个使用 PDFKit 生成的 PDF 文档', { align: 'left', features: ['cn'] });
    doc.moveDown();
    
    // 添加时间戳
    doc.fontSize(10).text(`生成时间: ${new Date().toLocaleString('zh-CN')}`, { align: 'right' });
    
    // 结束文档
    doc.end();
    
    // 监听完成事件
    writeStream.on('finish', () => {
      resolve({ success: true, message: `PDF 已生成: ${outputPath}` });
    });
    
    // 监听错误事件
    writeStream.on('error', (err) => {
      reject({ success: false, message: `生成失败: ${err.message}` });
    });
  });
}

export { handler };