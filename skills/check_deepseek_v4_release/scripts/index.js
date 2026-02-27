import https from 'https';

function checkDeepSeekV4Release() {
    const options = {
        hostname: 'www.deepseek.com',
        path: '/blog',
        method: 'GET',
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
    };

    const req = https.request(options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
            data += chunk;
        });

        res.on('end', () => {
            // 检查是否有V4相关内容
            if (data.includes('V4') || data.includes('v4') || data.includes('Version 4')) {
                console.log('发现DeepSeek V4相关内容，请访问官网博客查看详情：https://www.deepseek.com/blog');
            } else {
                console.log('目前DeepSeek官网博客中未提及V4版本的发布信息。');
                console.log('建议关注以下渠道获取最新消息：');
                console.log('- DeepSeek官方博客：https://www.deepseek.com/blog');
                console.log('- DeepSeek官方Twitter：https://twitter.com/deepseek_ai');
                console.log('- DeepSeek GitHub仓库：https://github.com/deepseek-ai');
            }
        });
    });

    req.on('error', (e) => {
        console.error('请求错误：', e.message);
        console.log('无法直接获取信息，请手动访问DeepSeek官方渠道查询V4版本发布时间。');
    });

    req.end();
}

checkDeepSeekV4Release();