# 🚀 Zalo API Final - API Zalo Cá Nhân Hoàn Chỉnh

## Ứng dụng Zalo Product Monitor

Repository này có thêm ứng dụng local chỉ đọc để map tin mô tả laptop, ảnh và lượt tym từ một nhóm Zalo sang SQLite và Excel, kèm giao diện realtime. Xem hướng dẫn cài đặt, vận hành và recovery tại [apps/product-monitor/README.md](apps/product-monitor/README.md).

[![npm version](https://badge.fury.io/js/zalo-api-final.svg)](https://badge.fury.io/js/zalo-api-final)
[![Downloads](https://img.shields.io/npm/dm/zalo-api-final.svg)](https://www.npmjs.com/package/zalo-api-final)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Thư viện API Zalo cá nhân mạnh mẽ và hoàn chỉnh nhất cho JavaScript/TypeScript**

✨ Phiên bản cuối cùng và tốt nhất của zalo-api-final với nhiều cải tiến về bảo mật, ổn định và tính năng.

## 📖 Tài liệu chính thức

🔗 **[Xem hướng dẫn đầy đủ tại Documentation](https://hiennguyen270995.github.io/zalo-api-final/)**

Tài liệu bao gồm:
- 📋 Hướng dẫn cài đặt và sử dụng từng bước
- 🔧 API Methods và Examples chi tiết
- 📚 Models & Types reference
- 🎧 Event Listeners và Webhook
- 🔐 Các phương thức đăng nhập
- 🎯 Ví dụ thực tế và best practices

## 🎯 Dành cho ai?

- 🏢 **Doanh nghiệp** muốn quản lý nhiều tài khoản Zalo để tăng doanh số
- 💻 **Developer** xây dựng bot, backend, hoặc ứng dụng tích hợp Zalo
- 🔧 **N8N Users** tạo node tự động hóa workflow Zalo
- 📱 **Marketer** cần tự động hóa marketing qua Zalo
- 🛒 **Bán hàng online** quản lý khách hàng qua Zalo

## ⭐ Tính năng chính

### 💬 Quản lý tin nhắn
- ✅ Gửi tin nhắn văn bản, hình ảnh, video
- ✅ Gửi sticker, emoji, link preview
- ✅ Forward tin nhắn
- ✅ Xóa tin nhắn đã gửi
- ✅ Nhận webhook tin nhắn real-time

### 👥 Quản lý bạn bè
- ✅ Lấy danh sách bạn bè
- ✅ Tìm kiếm người dùng qua số điện thoại
- ✅ Gửi lời mời kết bạn
- ✅ Chấp nhận/từ chối lời mời kết bạn
- ✅ Hủy lời mời đã gửi
- ✅ Chặn/bỏ chặn người dùng
- ✅ Đặt/xóa biệt danh bạn bè

### 🏘️ Quản lý nhóm
- ✅ Tạo nhóm mới
- ✅ Thêm/xóa thành viên
- ✅ Thay đổi tên nhóm, avatar
- ✅ Đặt/xóa phó nhóm
- ✅ Chuyển quyền quản trị
- ✅ Chặn/bỏ chặn thành viên
- ✅ Tạo link mời nhóm
- ✅ Giải tán nhóm

### 🔔 Webhook & Events
- ✅ Lắng nghe tin nhắn mới
- ✅ Theo dõi thay đổi nhóm
- ✅ Nhận thông báo bạn bè
- ✅ Event typing, seen, delivered

### 🛠️ Tính năng nâng cao
- ✅ Tạo poll/bình chọn
- ✅ Quản lý ghi chú nhóm
- ✅ Tạo reminder/nhắc nhở
- ✅ Upload file đính kèm
- ✅ Quản lý thông tin cá nhân

## 🚀 Ứng dụng thực tế

### 🏢 Multi-Account Management cho Doanh nghiệp
```javascript
import { Zalo } from 'zalo-api-final';

// Quản lý nhiều tài khoản Zalo
const accounts = [
  new Zalo({ sessionId: 'account1' }),
  new Zalo({ sessionId: 'account2' }),
  new Zalo({ sessionId: 'account3' })
];

// Gửi tin nhắn marketing hàng loạt
for (const zalo of accounts) {
  await zalo.sendMessage({
    userId: 'customer_id',
    message: 'Khuyến mãi đặc biệt hôm nay!'
  });
}
```

### 🔧 Xây dựng Node N8N
```javascript
// Tạo node N8N tùy chỉnh
export class ZaloNode implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Zalo',
    name: 'zalo',
    // ... cấu hình node
  };

  async execute(this: IExecuteFunctions) {
    const zalo = new Zalo();
    // Logic xử lý
  }
}
```

### 📱 Backend API Server
```javascript
import express from 'express';
import { Zalo } from 'zalo-api-final';

const app = express();
const zalo = new Zalo();

// API endpoint gửi tin nhắn
app.post('/send-message', async (req, res) => {
  const { userId, message } = req.body;
  
  try {
    await zalo.sendMessage({ userId, message });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(3000);
```

### 🛒 Phần mềm bán hàng
```javascript
class ZaloSalesBot {
  constructor() {
    this.zalo = new Zalo();
  }

  // Tự động trả lời khách hàng
  async handleCustomerMessage(message) {
    if (message.includes('giá')) {
      await this.sendPriceList(message.userId);
    }
    
    if (message.includes('đặt hàng')) {
      await this.processOrder(message.userId);
    }
  }

  // Gửi bảng giá
  async sendPriceList(userId) {
    await this.zalo.sendMessage({
      userId,
      message: '📋 Bảng giá sản phẩm:\n...'
    });
  }
}
```

## ☕ Ủng hộ dự án

Nếu thư viện này giúp bạn tiết kiệm thời gian hoặc giải quyết được vấn đề, hãy cân nhắc ủng hộ tác giả một ☕ để duy trì và phát triển thêm tính năng mới!

**📱 Quét QR Code để mời cafe:**

<div align="center">
<img src="qr.png" alt="QR Code VietinBank" width="200">
</div>

*VietinBank - 100884532014 - NGUYEN THI HIEN*

## � Tài liệu chi tiết

Xem tài liệu API đầy đủ tại: **[https://hiennguyen270995.github.io/zalo-api-final/](https://hiennguyen270995.github.io/zalo-api-final/)**

- 📖 [API Methods](https://hiennguyen270995.github.io/zalo-api-final/#/api/)
- 🏗️ [Models & Types](https://hiennguyen270995.github.io/zalo-api-final/#/models/)
- 🎧 [Event Listeners](https://hiennguyen270995.github.io/zalo-api-final/#/listeners/)
- 🔐 [Login Methods](https://hiennguyen270995.github.io/zalo-api-final/#/login/)

## �📦 Cài đặt

```bash
# NPM
npm install zalo-api-final

# Yarn
yarn add zalo-api-final

# PNPM
pnpm add zalo-api-final
```

## 🔧 Sử dụng cơ bản

### Đăng nhập QR Code
```javascript
import { Zalo } from 'zalo-api-final';

const zalo = new Zalo();

// Đăng nhập bằng QR
await zalo.loginQR((qr) => {
  console.log('Quét mã QR này để đăng nhập:');
  console.log(qr);
});

console.log('Đăng nhập thành công!');
```

### Gửi tin nhắn
```javascript
// Gửi tin nhắn văn bản
await zalo.sendMessage({
  userId: 'recipient_id',
  message: 'Xin chào! 👋'
});

// Gửi hình ảnh
await zalo.sendMessage({
  userId: 'recipient_id',
  attachment: {
    type: 'image',
    url: 'https://example.com/image.jpg'
  }
});
```

### Quản lý bạn bè
```javascript
// Lấy danh sách bạn bè
const friends = await zalo.getAllFriends();

// Gửi lời mời kết bạn
await zalo.sendFriendRequest({
  phone: '0123456789',
  message: 'Xin chào, kết bạn nhé!'
});

// Chấp nhận lời mời kết bạn
await zalo.acceptFriendRequest('request_id');
```

### Quản lý nhóm
```javascript
// Tạo nhóm mới
const group = await zalo.createGroup({
  name: 'Nhóm Marketing',
  members: ['user1', 'user2', 'user3']
});

// Thêm thành viên vào nhóm
await zalo.addUserToGroup({
  groupId: group.id,
  userId: 'new_member_id'
});
```

### Lắng nghe webhook
```javascript
// Lắng nghe tin nhắn mới
zalo.listen((message) => {
  console.log('Tin nhắn mới:', message);
  
  // Tự động trả lời
  if (message.type === 'text') {
    zalo.sendMessage({
      userId: message.userId,
      message: `Bạn vừa nói: ${message.text}`
    });
  }
});
```

## 🏗️ Ví dụ nâng cao

### Hệ thống customer service tự động
```javascript
class ZaloCustomerService {
  constructor() {
    this.zalo = new Zalo();
    this.supportKeywords = {
      'hỗ trợ': this.handleSupport,
      'khiếu nại': this.handleComplaint,
      'đơn hàng': this.handleOrder
    };
  }

  async start() {
    await this.zalo.loginQR();
    
    this.zalo.listen(async (message) => {
      for (const [keyword, handler] of Object.entries(this.supportKeywords)) {
        if (message.text.toLowerCase().includes(keyword)) {
          await handler.call(this, message);
          break;
        }
      }
    });
  }

  async handleSupport(message) {
    await this.zalo.sendMessage({
      userId: message.userId,
      message: '🆘 Chúng tôi sẽ hỗ trợ bạn ngay! Vui lòng mô tả vấn đề cụ thể.'
    });
  }
}
```

### Multi-account marketing automation
```javascript
class ZaloMarketing {
  constructor(accounts) {
    this.accounts = accounts.map(acc => new Zalo(acc));
  }

  async broadcastMessage(message, customerList) {
    const chunks = this.chunkArray(customerList, this.accounts.length);
    
    const promises = chunks.map(async (chunk, index) => {
      const zalo = this.accounts[index];
      
      for (const customerId of chunk) {
        await zalo.sendMessage({
          userId: customerId,
          message: this.personalizeMessage(message, customerId)
        });
        
        // Delay để tránh spam
        await this.delay(1000);
      }
    });

    await Promise.all(promises);
  }

  personalizeMessage(template, customerId) {
    // Cá nhân hóa tin nhắn
    return template.replace('{name}', this.getCustomerName(customerId));
  }
}
```

## 🔒 Bảo mật & Lưu ý

### ⚠️ Lưu ý quan trọng
- Thư viện này dành cho mục đích học tập và phát triển
- Việc sử dụng có thể vi phạm điều khoản dịch vụ của Zalo
- Tác giả không chịu trách nhiệm nếu tài khoản bị khóa
- Hãy sử dụng có trách nhiệm và tuân thủ pháp luật

### 🛡️ Best practices
```javascript
// Sử dụng rate limiting
const rateLimiter = new RateLimit({
  windowMs: 60000, // 1 phút
  max: 30 // Tối đa 30 tin nhắn/phút
});

// Xử lý lỗi properly
try {
  await zalo.sendMessage(params);
} catch (error) {
  if (error.code === 'RATE_LIMITED') {
    await delay(60000); // Chờ 1 phút
    return retry();
  }
  
  console.error('Lỗi:', error.message);
}
```

## 🤝 Đóng góp

Chúng tôi hoan nghênh mọi đóng góp! Hãy:

1. Fork repository này
2. Tạo nhánh tính năng (`git checkout -b tinh-nang/TinhNangTuyetVoi`)
3. Commit thay đổi (`git commit -m 'Thêm tính năng tuyệt vời'`)
4. Push lên nhánh (`git push origin tinh-nang/TinhNangTuyetVoi`)
5. Mở Pull Request

## 📞 Hỗ trợ

- 📧 Email: hiennguyen270995@gmail.com
- 🐛 Issues: [GitHub Issues](https://github.com/hiennguyen270995/zalo-api-final/issues)
- 💬 Discussions: [GitHub Discussions](https://github.com/hiennguyen270995/zalo-api-final/discussions)

## 📝 Changelog

### v2.1.0
- ✨ Thêm hỗ trợ multi-account management
- 🚀 Cải thiện performance và stability
- 🔧 Tối ưu hóa cho N8N integration
- 📖 Hoàn thiện documentation tiếng Việt
- 🛡️ Tăng cường bảo mật

### v2.0.0
- 🎉 Release chính thức
- 📦 Hỗ trợ cả ESM và CommonJS
- 🔄 Rebuild từ zalo-api-final với nhiều cải tiến
- 🎯 Tối ưu cho business applications

## 📄 License

MIT License - xem [LICENSE](LICENSE) để biết thêm chi tiết.

##  Credits

Dựa trên thư viện [zalo-api-final](https://github.com/hiennguyen270995/zalo-api-final) với nhiều cải tiến và tối ưu hóa.

---

**⭐ Nếu thư viện hữu ích, hãy cho chúng tôi một star trên GitHub!**

**💡 Có ý tưởng tính năng mới? Hãy tạo issue để thảo luận!**

**💡 Có ý tưởng tính năng mới? Hãy tạo issue để thảo luận!**
