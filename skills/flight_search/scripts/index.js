import axios from 'axios';

export async function handler(args) {
  const { date } = args;
  
  try {
    // 模拟真实API调用（实际需要替换为有效的机票API）
    // 这里使用mock数据模拟真实响应格式
    const mockResponse = {
      data: {
        itineraries: [
          {
            legs: [
              {
                carrierIds: ['CA'],
                departure: { iataCode: 'HGH', at: `${date}T08:00:00` },
                arrival: { iataCode: 'CAN', at: `${date}T10:35:00` },
                duration: 'PT2H35M',
                flightNumbers: [{ number: 'CZ3520' }]
              }
            ],
            price: { total: '890', currency: 'CNY' }
          },
          {
            legs: [
              {
                carrierIds: ['MU'],
                departure: { iataCode: 'HGH', at: `${date}T10:15:00` },
                arrival: { iataCode: 'CAN', at: `${date}T12:50:00` },
                duration: 'PT2H35M',
                flightNumbers: [{ number: 'MU5211' }]
              }
            ],
            price: { total: '950', currency: 'CNY' }
          },
          {
            legs: [
              {
                carrierIds: ['MF'],
                departure: { iataCode: 'HGH', at: `${date}T14:30:00` },
                arrival: { iataCode: 'CAN', at: `${date}T17:05:00` },
                duration: 'PT2H35M',
                flightNumbers: [{ number: 'MF8317' }]
              }
            ],
            price: { total: '780', currency: 'CNY' }
          }
        ],
        carriers: {
          'CA': { name: '中国南方航空' },
          'MU': { name: '中国东方航空' },
          'MF': { name: '厦门航空' }
        }
      }
    };
    
    // 转换为用户友好的格式
    const flights = mockResponse.data.itineraries.map(itinerary => {
      const leg = itinerary.legs[0];
      const carrier = mockResponse.data.carriers[leg.carrierIds[0]];
      return {
        airline: carrier.name,
        flightNo: leg.flightNumbers[0].number,
        departureTime: leg.departure.at.split('T')[1].substring(0, 5),
        arrivalTime: leg.arrival.at.split('T')[1].substring(0, 5),
        price: parseInt(itinerary.price.total),
        duration: leg.duration.replace('PT', '').replace('H', '小时').replace('M', '分钟')
      };
    });
    
    return {
      success: true,
      data: {
        date: date,
        from: '杭州萧山国际机场 (HGH)',
        to: '广州白云国际机场 (CAN)',
        flights: flights
      },
      message: '数据来自模拟API，实际请使用真实机票API获取实时数据'
    };
  } catch (error) {
    return {
      success: false,
      error: `查询失败: ${error.message}`
    };
  }
}