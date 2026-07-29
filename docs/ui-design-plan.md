# Kế hoạch thiết kế giao diện — Zalo Group Monitor

## 1. Mục tiêu sản phẩm

Xây dựng một công cụ chạy local để theo dõi tin nhắn từ các nhóm Zalo theo thời gian thực. Giao diện phải giúp người vận hành:

- đăng nhập bằng QR và biết rõ trạng thái kết nối;
- chọn nhóm cần theo dõi;
- đọc luồng tin nhắn mới theo thời gian thực;
- tìm kiếm, lọc và xem chi tiết tin nhắn;
- nhận biết lỗi kết nối hoặc gián đoạn dữ liệu;
- xác nhận rõ rằng hệ thống chỉ đọc và không tương tác lại với Zalo.

### Ngoài phạm vi

- gửi, sửa, thu hồi hoặc chuyển tiếp tin nhắn;
- reaction, typing, seen hoặc delivered event;
- thêm/xóa thành viên và quản trị nhóm;
- chiến dịch marketing hoặc tự động trả lời;
- chỉnh sửa nội dung đã lưu từ giao diện.

## 2. Nguyên tắc UX

1. **Read-only phải luôn nhìn thấy**  
   Header hiển thị nhãn `Chỉ đọc`. Không đặt nút soạn tin, reaction hoặc thao tác quản trị trong giao diện.

2. **Trạng thái kết nối luôn rõ ràng**  
   Người dùng phải phân biệt được: chưa đăng nhập, đang chờ quét QR, đang kết nối, đã kết nối, đang kết nối lại và mất kết nối.

3. **Ưu tiên luồng tin nhắn**  
   Sau khi đăng nhập, người dùng đi thẳng vào màn hình theo dõi. Các thiết lập ít dùng được đặt trong trang riêng.

4. **Không làm mất vị trí đọc**  
   Khi người dùng đang đọc tin cũ, tin mới không tự kéo màn hình xuống. Hiển thị nút `Có N tin nhắn mới` để người dùng chủ động quay về cuối luồng.

5. **Lỗi xuất hiện tại nơi xảy ra**  
   Lỗi QR nằm tại thẻ đăng nhập; lỗi tải nhóm nằm trong danh sách nhóm; lỗi stream nằm trên luồng tin nhắn.

6. **Mỗi empty state có một hành động chính**  
   Ví dụ: chưa chọn nhóm → `Chọn nhóm để theo dõi`; chưa đăng nhập → `Tạo mã QR`.

## 3. Kiến trúc thông tin

```text
Zalo Group Monitor
├── Đăng nhập
│   ├── QR code
│   ├── Trạng thái phiên
│   └── Hướng dẫn quét QR
├── Theo dõi
│   ├── Danh sách nhóm
│   ├── Luồng tin nhắn
│   └── Chi tiết tin nhắn
├── Lịch sử
│   ├── Tìm kiếm
│   ├── Bộ lọc
│   └── Kết quả
└── Cài đặt
    ├── Nhóm được theo dõi
    ├── Lưu trữ dữ liệu
    ├── Kết nối
    └── Thông tin hệ thống
```

## 4. Cấu trúc màn hình

### 4.1. Màn hình đăng nhập

Mục tiêu: hoàn thành kết nối mà không yêu cầu người dùng hiểu cookie hay WebSocket.

Nội dung:

- logo/tên công cụ;
- nhãn `Chạy cục bộ` và `Chỉ đọc`;
- QR code kích thước đủ quét;
- thời gian còn lại của QR;
- trạng thái đăng nhập;
- nút `Tạo mã QR mới` khi hết hạn;
- hướng dẫn ba bước ngắn;
- cảnh báo đây là API Zalo cá nhân không chính thức.

Trạng thái:

- khởi tạo;
- đang tạo QR;
- chờ quét;
- đã quét, chờ xác nhận;
- đăng nhập thành công;
- QR hết hạn;
- đăng nhập bị từ chối;
- lỗi mạng.

### 4.2. Màn hình theo dõi

Desktop dùng bố cục ba vùng:

```text
┌──────────────────────────────────────────────────────────────────┐
│ Zalo Group Monitor   Đã kết nối   Chỉ đọc    Tìm kiếm   Cài đặt │
├───────────────┬──────────────────────────────┬───────────────────┤
│ Nhóm          │ Luồng tin nhắn               │ Chi tiết          │
│               │                              │                   │
│ Tất cả        │ Tên nhóm                     │ Người gửi         │
│ Nhóm A        │ trạng thái stream            │ Thời gian         │
│ Nhóm B        │                              │ Nội dung đầy đủ   │
│ Nhóm C        │ [tin nhắn...]                │ Attachment        │
│               │                              │ Dữ liệu kỹ thuật  │
├───────────────┴──────────────────────────────┴───────────────────┤
│ Đã lưu N tin • Tin gần nhất HH:mm:ss • SQLite local             │
└──────────────────────────────────────────────────────────────────┘
```

#### Cột nhóm

- ô tìm nhóm;
- mục `Tất cả nhóm đang theo dõi`;
- tên nhóm và avatar;
- số tin chưa xem;
- chấm trạng thái khi vừa có tin mới;
- menu lọc: đang theo dõi / tạm ẩn;
- nút `Quản lý nhóm theo dõi`.

Không dùng checkbox trực tiếp trên luồng chính; việc bật/tắt theo dõi nằm trong dialog hoặc trang cài đặt để tránh thao tác nhầm.

#### Luồng tin nhắn

- header: tên nhóm, số thành viên nếu có, trạng thái stream;
- filter nhanh: tất cả, văn bản, ảnh/file, theo người gửi;
- danh sách tin theo thời gian;
- phân cách ngày;
- avatar, tên người gửi, giờ gửi;
- nội dung tối đa bốn dòng ở chế độ danh sách;
- preview attachment;
- badge `Tin của tôi` nếu bật thu thập tin do chính tài khoản gửi;
- nút nổi `Có N tin nhắn mới` khi người dùng không ở cuối luồng.

Không hiển thị ô nhập tin nhắn.

#### Panel chi tiết

- metadata đã chuẩn hóa;
- nội dung đầy đủ;
- danh sách attachment;
- ID nhóm, ID người gửi, message ID;
- thời gian Zalo và thời gian hệ thống nhận;
- raw event trong disclosure `Dữ liệu kỹ thuật`;
- nút `Sao chép JSON`, không có thao tác ghi về Zalo.

### 4.3. Màn hình lịch sử

Mục tiêu: tra cứu dữ liệu SQLite mà không ảnh hưởng stream hiện tại.

Bộ lọc:

- từ khóa;
- một hoặc nhiều nhóm;
- người gửi;
- khoảng thời gian;
- loại nội dung;
- có/không có attachment.

Kết quả hiển thị dạng danh sách, không dùng bảng rộng vì nội dung tin nhắn có độ dài thay đổi. URL lưu trạng thái bộ lọc để reload không mất truy vấn.

### 4.4. Màn hình cài đặt

Các section:

- **Nhóm theo dõi:** bật/tắt lưu tin cho từng nhóm;
- **Dữ liệu:** vị trí database, thời gian lưu, dung lượng;
- **Kết nối:** tự kết nối lại, trạng thái phiên, đăng xuất;
- **Hiển thị:** theme sáng/tối và mật độ danh sách;
- **Hệ thống:** phiên bản ứng dụng, phiên bản thư viện, log gần nhất.

Các thao tác xóa lịch sử hoặc đăng xuất phải dùng `AlertDialog`.

## 5. Luồng sử dụng chính

### Lần đầu sử dụng

```text
Mở công cụ
→ Tạo QR
→ Quét bằng Zalo
→ Kết nối thành công
→ Tải danh sách nhóm
→ Chọn nhóm cần theo dõi
→ Bắt đầu nhận và lưu tin nhắn
```

### Mất kết nối

```text
WebSocket đóng
→ Header chuyển sang "Đang kết nối lại"
→ Giữ nguyên dữ liệu đang xem
→ Retry nền
→ Thành công: tiếp tục stream + ghi nhận khoảng gián đoạn
→ Thất bại: hiển thị hành động "Kết nối lại"
```

### Đọc tin mới

```text
Tin nhắn đến
→ Lưu SQLite
→ Cập nhật số đếm nhóm
→ Nếu đang ở cuối luồng: thêm tin vào danh sách
→ Nếu đang đọc tin cũ: giữ vị trí + hiện nút tin mới
```

## 6. Design system

### Phong cách

- dashboard vận hành, ít trang trí;
- nền trung tính, bề mặt trắng/xám;
- một màu nhấn xanh lam cho selection và hành động chính;
- xanh lá chỉ dành cho trạng thái kết nối;
- vàng/cam cho reconnect hoặc cảnh báo;
- đỏ chỉ dành cho lỗi và thao tác xóa dữ liệu local;
- không gradient, glow hoặc animation trang trí.

### Typography

- font sans-serif hệ thống hoặc Inter;
- heading dùng `text-balance`;
- nội dung dài dùng `text-pretty`;
- timestamp và số đếm dùng `tabular-nums`;
- nội dung dày dùng `truncate` hoặc `line-clamp`.

### Spacing và component

- dùng thang spacing mặc định của Tailwind;
- bán kính vừa phải, shadow mặc định;
- icon button luôn có tooltip và `aria-label`;
- dùng một hệ primitive accessible duy nhất, ưu tiên Base UI;
- dùng skeleton có cấu trúc khi tải QR, nhóm và lịch sử.

### Motion

Không dùng animation trang trí. Chỉ dùng transition opacity/transform ngắn, tối đa 200 ms, cho tooltip, dialog và panel mobile; tôn trọng `prefers-reduced-motion`.

## 7. Responsive

### Desktop từ 1280 px

- ba cột: nhóm 280 px, luồng co giãn, chi tiết 360 px;
- panel chi tiết có thể thu gọn.

### Tablet 768–1279 px

- hai cột: nhóm và luồng;
- chi tiết mở bằng drawer.

### Mobile dưới 768 px

- điều hướng theo tầng: danh sách nhóm → luồng → chi tiết;
- header cố định có safe-area inset;
- filter mở bằng bottom sheet;
- không cố nhồi ba cột vào một viewport.

## 8. Trạng thái bắt buộc phải thiết kế

- loading QR;
- QR hết hạn;
- đăng nhập thất bại;
- chưa có nhóm;
- chưa chọn nhóm;
- nhóm chưa có tin nhắn;
- tin nhắn chỉ có attachment;
- attachment không tải được;
- đang tải lịch sử cũ;
- đang kết nối lại;
- mất kết nối dài;
- database không ghi được;
- không có kết quả tìm kiếm;
- phiên đăng nhập hết hạn.

## 9. Accessibility

- toàn bộ chức năng dùng được bằng bàn phím;
- focus ring nhìn rõ;
- danh sách nhóm và tin nhắn có semantic phù hợp;
- trạng thái kết nối dùng text và icon, không chỉ dựa vào màu;
- cập nhật tin mới dùng live region mức `polite`, tránh đọc liên tục từng message;
- contrast tối thiểu WCAG AA;
- dialog trap focus bằng primitive có sẵn;
- target tương tác tối thiểu 40 × 40 px;
- không chặn paste trong ô tìm kiếm.

## 10. Dữ liệu UI cần từ backend

```ts
type ConnectionState =
    | "signed_out"
    | "creating_qr"
    | "waiting_for_scan"
    | "waiting_for_confirmation"
    | "connected"
    | "reconnecting"
    | "disconnected"
    | "session_expired";

type GroupSummary = {
    id: string;
    name: string;
    avatarUrl?: string;
    monitored: boolean;
    unreadCount: number;
    lastMessageAt?: number;
};

type ReadonlyMessage = {
    id: string;
    groupId: string;
    senderId: string;
    senderName?: string;
    senderAvatarUrl?: string;
    content?: string;
    messageType: string;
    attachments: ReadonlyArray<{
        type: string;
        name?: string;
        url?: string;
        size?: number;
    }>;
    sentAt: number;
    receivedAt: number;
    isSelf: boolean;
};
```

Sự kiện real-time từ backend tới UI:

- `connection.state_changed`;
- `qr.updated`;
- `groups.snapshot`;
- `group.updated`;
- `message.created`;
- `stream.gap_detected`;
- `storage.error`.

## 11. Kế hoạch triển khai UI

### Giai đoạn 1 — Shell và dữ liệu giả

- app shell, navigation và responsive layout;
- màn hình login QR;
- màn hình monitor ba vùng;
- fixtures cho nhóm, tin nhắn và connection state;
- đầy đủ loading/empty/error states.

### Giai đoạn 2 — Kết nối backend

- Socket.IO client;
- state machine đăng nhập/kết nối;
- tải danh sách nhóm;
- stream tin nhắn;
- pagination lịch sử;
- reconnect không làm mất vị trí đọc.

### Giai đoạn 3 — Lịch sử và cài đặt

- tìm kiếm/bộ lọc;
- quản lý nhóm theo dõi;
- thống kê dung lượng database;
- đăng xuất và xóa dữ liệu local bằng confirmation dialog.

### Giai đoạn 4 — Hoàn thiện

- keyboard navigation;
- accessibility audit;
- responsive QA;
- kiểm tra luồng mất mạng/session hết hạn;
- kiểm tra hiệu năng với danh sách tin nhắn dài.

## 12. Tiêu chí nghiệm thu UI

- người dùng mới có thể đăng nhập và tới màn hình monitor mà không cần đọc tài liệu;
- trạng thái kết nối luôn nhìn thấy trên mọi màn hình;
- không có bất kỳ control gửi hoặc tương tác lại với Zalo;
- tin mới xuất hiện mà không làm giật vị trí đọc;
- tìm được tin theo nhóm, người gửi, từ khóa và thời gian;
- desktop, tablet và mobile đều có bố cục sử dụng được;
- tất cả loading, empty và error state quan trọng đều có giao diện;
- điều hướng bàn phím và focus hoạt động đúng;
- giao diện thể hiện rõ dữ liệu được lưu local.
