import axios from 'axios';

/**
 * 查询杭州到广州的机票信息
 * @param {string} date - 出发日期，格式为'YYYY-MM-DD'
 * @returns {Promise<Object>} 机票搜索结果
 */
async function searchFlights(date) {
    try {
        // 使用SkyScanner的免费API（需要注册获取API密钥）
        // 这里使用示例URL，实际使用时需要替换为有效的API端点
        const apiKey = 'YOUR_API_KEY'; // 需要用户注册获取
        const url = `https://skyscanner-api.p.rapidapi.com/v3/flights/indicative/search`;
        
        const params = {
            market: 'CN',
            currency: 'CNY',
            locale: 'zh-CN',
            originplace: 'HGH-sky', // 杭州萧山机场
            destinationplace: 'CAN-sky', // 广州白云机场
            outbounddate: date
        };

        const headers = {
            'X-RapidAPI-Key': apiKey,
            'X-RapidAPI-Host': 'skyscanner-api.p.rapidapi.com'
        };

        const response = await axios.get(url, { params, headers });
        return response.data;
    } catch (error) {
        console.error('机票查询失败:', error.message);
        // 如果API调用失败，返回模拟数据作为示例
        return {
            message: 'API调用失败，请检查API密钥或使用其他API',
            exampleData: {
                origin: '杭州萧山机场 (HGH)',
                destination: '广州白云机场 (CAN)',
                date: date,
                flights: [
                    {
                        airline: '中国南方航空',
                        flightNumber: 'CZ3520',
                        departureTime: '08:00',
                        arrivalTime: '10:35',
                        price: 890,
                        duration: '2小时35分钟'
                    },
                    {
                        airline: '中国东方航空',
                        flightNumber: 'MU5211',
                        departureTime: '10:15',
                        arrivalTime: '12:50',
                        price: 950,
                        duration: '2小时35分钟'
                    },
                    {
                        airline: '厦门航空',
                        flightNumber: 'MF8317',
                        departureTime: '14:30',
                        arrivalTime: '17:05',
                        price: 780,
                        duration: '2小时35分钟'
                    }
                ]
            }
        };
    }
}

// 示例用法
const today = new Date().toISOString().split('T')[0];
searchFlights(today).then(result => {
    console.log('杭州到广州的机票信息:');
    console.log(JSON.stringify(result, null, 2));
}).catch(err => {
    console.error('查询出错:', err);
});