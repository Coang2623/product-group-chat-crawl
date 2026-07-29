# Thiết kế tính năng tự động map sản phẩm Zalo sang Excel

Ngày: 2026-07-29  
Trạng thái: Đã được người dùng duyệt

## 1. Bối cảnh

Công cụ hiện theo dõi tin nhắn Zalo theo thời gian thực ở chế độ chỉ đọc. Người dùng có một nhóm Zalo chuyên cập nhật laptop. Công cụ cần lấy mô tả, hình ảnh và lượng thả tim của từng sản phẩm, chuẩn hóa dữ liệu, hiển thị trên giao diện thời gian thực và đồng bộ sang Excel.

Trong nhóm:

- người dùng chọn đúng một nhóm để theo dõi từ danh sách nhóm Zalo;
- chỉ quản trị viên đăng sản phẩm;
- mỗi tin nhắn mô tả tương ứng đúng một sản phẩm;
- quản trị viên gửi mô tả trước, sau đó gửi các ảnh sản phẩm;
- một mô tả mới đánh dấu kết thúc sản phẩm trước;
- sản phẩm chỉ thuộc nhóm laptop.

## 2. Mục tiêu

- Tự động tạo một bản ghi sản phẩm ngay khi nhận mô tả.
- Ghép các ảnh gửi sau vào đúng sản phẩm đang mở.
- Chuẩn hóa cấu hình và giá laptop khi nội dung theo cấu trúc đã biết.
- Không suy đoán khi nội dung lệch cấu trúc.
- Cập nhật lượng thả tim theo thời gian thực.
- Hiển thị bảng sản phẩm trực tiếp trên giao diện.
- Đồng bộ an toàn vào một workbook Excel, chia sheet theo tháng.
- Không mất dữ liệu khi Excel đang mở, tiến trình bị dừng hoặc ảnh tải lỗi.

## 3. Ngoài phạm vi

- Theo dõi nhiều nhóm đồng thời.
- Gửi, sửa, thu hồi hoặc reaction lại tin nhắn Zalo.
- Tự động sửa nội dung sản phẩm bị parser đánh dấu lỗi.
- Nhận diện sản phẩm ngoài laptop.
- Dùng AI hoặc dịch vụ bên ngoài để suy đoán trường còn thiếu.
- Gộp các bài đăng trùng sản phẩm.

## 4. Quyết định sản phẩm

- Một tin nhắn mô tả luôn tạo một dòng mới, kể cả sản phẩm được đăng lại.
- Một workbook duy nhất: `zalo-products.xlsx`.
- Mỗi tháng là một sheet có tên `YYYY-MM`.
- Ảnh đầu tiên được nhúng vào Excel làm ảnh đại diện.
- Toàn bộ ảnh được lưu ngoài workbook theo thư mục sản phẩm; Excel chứa hyperlink mở thư mục.
- Tin nhắn lệch cấu trúc vẫn được ghi, nhưng chỉ điền metadata, ảnh và nội dung gốc; trạng thái là `Cần kiểm tra`.
- Cấu hình hoặc giá thay thế trong cùng bài được giữ nguyên trong cột `Ghi chú`.
- Dữ liệu được ghi tự động, không yêu cầu duyệt trước.
- Database local là nguồn dữ liệu chính; Excel là đầu ra đồng bộ.

## 5. Kiến trúc

Tính năng được chia thành các đơn vị độc lập:

### 5.1. Group Selection

- Tải danh sách nhóm từ tài khoản Zalo đã đăng nhập.
- Cho phép chọn một `activeGroupId`.
- Listener bỏ qua mọi message và reaction ngoài nhóm được chọn.
- Chỉ message của tài khoản quản trị viên/nguồn đăng sản phẩm đã xác định mới được dùng để mở draft hoặc ghép ảnh; message của thành viên khác không tạo sản phẩm.
- Việc đổi nhóm dừng pipeline nhóm cũ trước khi kích hoạt nhóm mới.

### 5.2. Product Draft Coordinator

Giữ tối đa một `activeProductDraft` do chỉ quản trị viên đăng sản phẩm.

Khi nhận mô tả:

1. Đóng draft đang mở, nếu có.
2. Tạo draft mới gắn với message ID của mô tả.
3. Chạy parser.
4. Lưu database.
5. Tạo tác vụ đồng bộ Excel.

Khi nhận ảnh:

1. Kiểm tra có draft đang mở.
2. Tải ảnh vào thư mục của draft.
3. Ảnh đầu tiên trở thành ảnh đại diện.
4. Cập nhật số ảnh và trạng thái tải.
5. Tạo hoặc gộp tác vụ đồng bộ Excel.

Người dùng có thể dùng `Kết thúc nhận ảnh` để đóng sản phẩm cuối cùng mà không cần chờ mô tả tiếp theo. Thao tác này chỉ thay đổi dữ liệu local.

### 5.3. Laptop Parser

Parser dùng quy tắc xác định, không dùng AI. Thứ tự nhận diện:

1. tên laptop;
2. CPU;
3. RAM;
4. SSD hoặc HDD;
5. card/GPU;
6. màn hình;
7. tình trạng;
8. giá;
9. phần còn lại vào ghi chú.

Parser chấp nhận:

- nội dung nhiều dòng;
- dấu `-`, `:` và khoảng trắng không đồng nhất;
- nhãn `GIÁ` hoặc `GIÁ THU VỀ`;
- các trường tùy chọn như card rời, vật liệu vỏ và tình trạng pin.

Nếu các trường cốt lõi không thể xác định đủ tin cậy, parser không điền từng trường mà lưu toàn bộ nội dung vào `Nội dung gốc` và đặt `Cần kiểm tra`.

### 5.4. Media Store

- Lưu ảnh theo cấu trúc `media/YYYY-MM/{product-id}/`.
- Tên file có thứ tự nhận và giữ phần mở rộng hợp lệ.
- Lưu checksum để tránh ghi trùng cùng một ảnh.
- Tải lỗi được retry; lỗi một ảnh không làm thất bại bản ghi sản phẩm.
- Ảnh đến khi chưa có draft được đưa vào danh sách `Ảnh chưa ghép`.

### 5.5. Reaction Aggregator

Source cung cấp sự kiện `reaction` và `old_reactions`, không cung cấp trực tiếp tổng lượng tim.

Aggregator:

- nhận diện tim bằng `rIcon = "/-heart"` hoặc loại tương đương `rType = 5`;
- xác định message đích bằng `gMsgID/cMsgID` và ánh xạ message mô tả hoặc message ảnh về product ID;
- tính số tim của sản phẩm trên toàn bộ cụm message gồm mô tả và các ảnh đã ghép;
- lưu trạng thái theo `productId + targetMessageId + userId`;
- nếu một người tim nhiều ảnh trong cùng sản phẩm, `heartCount` chỉ tính người đó một lần;
- xử lý thêm, đổi và gỡ reaction;
- nạp reaction cũ sau khi kết nối lại;
- cập nhật `heartCount` trong database và tác vụ Excel.

### 5.6. Excel Sync Worker

- Đọc thay đổi từ hàng chờ bền vững trong database.
- Tạo sheet tháng nếu chưa có.
- Tìm đúng dòng bằng product ID hoặc description message ID.
- Nhúng ảnh đại diện, cập nhật hyperlink thư mục, số ảnh, số tim và trạng thái.
- Gộp các cập nhật liên tiếp của cùng sản phẩm; chỉ giá trị mới nhất cần ghi.
- Ghi workbook vào file tạm, kiểm tra thành công rồi thay thế file chính.
- Giữ bản sao lưu gần nhất trước khi thay thế.

Nếu workbook bị Excel Desktop khóa:

- database và giao diện vẫn cập nhật bình thường;
- tác vụ giữ nguyên trong hàng chờ;
- giao diện hiện số thay đổi đang chờ;
- worker tự retry;
- người dùng có nút `Đồng bộ lại ngay`.

## 6. Mô hình dữ liệu

### 6.1. ProductRecord

```ts
type ProductStatus = "receiving_images" | "completed" | "needs_review";
type ExcelSyncStatus = "pending" | "synced" | "blocked" | "failed";

type ProductRecord = {
    id: string;
    groupId: string;
    groupName: string;
    descriptionMessageId: string;
    senderId: string;
    senderName?: string;
    postedAt: number;
    rawContent: string;
    productName?: string;
    brand?: string;
    model?: string;
    cpu?: string;
    ram?: string;
    storage?: string;
    gpu?: string;
    display?: string;
    condition?: string;
    price?: number;
    rawPrice?: string;
    notes?: string;
    imageCount: number;
    coverImagePath?: string;
    mediaDirectory: string;
    heartCount: number;
    status: ProductStatus;
    excelSyncStatus: ExcelSyncStatus;
    createdAt: number;
    updatedAt: number;
};
```

### 6.2. ProductMedia

```ts
type ProductMedia = {
    id: string;
    productId: string;
    sourceMessageId: string;
    sequence: number;
    localPath?: string;
    checksum?: string;
    downloadStatus: "pending" | "downloaded" | "failed";
    createdAt: number;
};
```

### 6.3. ProductReaction

```ts
type ProductReaction = {
    productId: string;
    targetMessageId: string;
    userId: string;
    icon: string;
    active: boolean;
    updatedAt: number;
};
```

### 6.4. ExcelSyncJob

```ts
type ExcelSyncJob = {
    productId: string;
    operation: "upsert";
    status: "pending" | "running" | "blocked" | "failed";
    attempts: number;
    lastError?: string;
    updatedAt: number;
};
```

## 7. Cấu trúc Excel

Mỗi sheet tháng có các cột theo thứ tự:

1. `STT`
2. `Ngày đăng`
3. `Giờ đăng`
4. `Ảnh đại diện`
5. `Tên sản phẩm`
6. `Thương hiệu`
7. `Model`
8. `CPU`
9. `RAM`
10. `Ổ cứng`
11. `Card/GPU`
12. `Màn hình`
13. `Tình trạng`
14. `Giá`
15. `Giá gốc`
16. `Ghi chú`
17. `Số ảnh`
18. `Thư mục ảnh`
19. `Số tym`
20. `Trạng thái`
21. `Nội dung gốc`
22. `Message ID`

`Giá` là số để Excel có thể lọc, sắp xếp và tính toán. `Giá gốc` giữ cách viết ban đầu.

Quy tắc chuẩn hóa:

- `5 TRIỆU` → `5.000.000`
- `3 TRIỆU 8` → `3.800.000`
- `5 TRIỆU 900` → `5.900.000`
- `4 TRIỆU 4` → `4.400.000`

## 8. Giao diện

Thêm mục `Sản phẩm` vào sidebar, ngay sau `Tin nhắn`.

### 8.1. Trạng thái chưa chọn nhóm

- Hiển thị danh sách nhóm Zalo.
- Chỉ cho chọn một nhóm.
- Giải thích chỉ dữ liệu mới từ nhóm được chọn mới đi vào pipeline.

### 8.2. Màn sản phẩm thời gian thực

Bố cục đã chọn: bảng là vùng chính, panel chi tiết bên phải.

Header:

- tên nhóm đang theo dõi;
- trạng thái listener;
- trạng thái Excel;
- số tác vụ đồng bộ đang chờ;
- nút `Đồng bộ lại ngay`.

Bảng:

- ảnh đại diện;
- thời gian;
- tên sản phẩm;
- cấu hình rút gọn;
- giá;
- số ảnh;
- số tim;
- trạng thái xử lý;
- trạng thái Excel.

Hành vi:

- dòng mới xuất hiện ngay khi nhận mô tả;
- dòng `Đang nhận ảnh` được ghim lên đầu;
- ảnh và số ảnh cập nhật tại chỗ;
- số tim cập nhật tại chỗ, không đổi vị trí dòng;
- lỗi parser và lỗi Excel dùng nhãn riêng, không chỉ dựa vào màu;
- bộ lọc nhanh gồm `Tất cả`, `Đang nhận ảnh`, `Cần kiểm tra`, `Chưa đồng bộ Excel`;
- tìm kiếm theo tên, CPU, RAM, SSD và khoảng giá.

Panel chi tiết:

- gallery ảnh;
- toàn bộ dữ liệu đã map;
- nội dung gốc;
- ghi chú;
- Message ID;
- lịch sử đồng bộ;
- `Mở thư mục ảnh`;
- `Kết thúc nhận ảnh`.

Không có thao tác gửi dữ liệu về Zalo.

## 9. Trạng thái và lỗi

- `Đang nhận ảnh`: đã có mô tả, đang nhận ảnh tiếp theo.
- `Hoàn tất`: có mô tả mới hoặc người dùng kết thúc thủ công.
- `Cần kiểm tra`: parser không nhận diện đủ cấu trúc.
- `Ảnh chưa ghép`: ảnh đến khi không có draft.
- `Chờ Excel`: dữ liệu đã lưu nhưng chưa ghi workbook.
- `Excel đang mở`: workbook bị khóa.
- `Đồng bộ lỗi`: lỗi không phải khóa file và đã retry thất bại.

Mọi lỗi phải giữ lại dữ liệu gốc và có thông báo hành động được.

## 10. Phục hồi

Khi khởi động:

1. Nạp `activeGroupId`.
2. Nạp draft `receiving_images`, nếu có.
3. Khởi động lại các tác vụ tải ảnh chưa xong.
4. Nạp hàng chờ Excel.
5. Yêu cầu reaction cũ và hợp nhất với trạng thái hiện có.
6. Bắt đầu listener mới.

Workbook có thể được tái tạo hoàn toàn từ database và media store.

## 11. Kiểm thử

### Parser

- MacBook Air với giá `5 TRIỆU`, `6 TRIỆU`.
- HP ProBook với giá `3 TRIỆU 8`.
- HP ZBook với GPU, vỏ và giá `5 TRIỆU 900`.
- Cấu hình thay thế được đưa vào ghi chú.
- Dấu hai chấm, xuống dòng và khoảng trắng khác nhau.
- Nội dung lệch cấu trúc tạo `Cần kiểm tra`.

### Ghép ảnh

- Một mô tả và nhiều ảnh liên tiếp.
- Mô tả mới đóng sản phẩm cũ.
- Kết thúc thủ công sản phẩm cuối.
- Ảnh lỗi tải và retry.
- Ảnh đến khi không có draft.
- Khởi động lại giữa lúc nhận ảnh.

### Reaction

- Thêm tim.
- Đổi từ reaction khác sang tim.
- Đổi từ tim sang reaction khác.
- Gỡ tim.
- Sự kiện trùng.
- Nạp reaction cũ sau reconnect.

### Excel

- Tạo workbook và sheet tháng.
- Chuyển tháng tạo sheet mới.
- Nhúng ảnh đầu tiên.
- Cập nhật số ảnh và số tim.
- Workbook đang mở.
- Đồng bộ bù sau khi đóng Excel.
- Lỗi ghi file không làm hỏng workbook chính.
- Khôi phục workbook từ database.

### Giao diện

- Bảng nhận dòng mới theo thời gian thực.
- Cập nhật ảnh và tim không làm nhảy vị trí đọc.
- Bộ lọc và tìm kiếm.
- Banner Excel bị khóa.
- Panel chi tiết và gallery.
- Trạng thái chỉ đọc luôn rõ ràng.

## 12. Tiêu chí nghiệm thu

- Người dùng chọn được đúng một nhóm từ danh sách nhóm Zalo.
- Chỉ dữ liệu từ nhóm được chọn được xử lý.
- Mỗi mô tả tạo đúng một dòng mới.
- Ảnh tiếp theo được ghép đúng sản phẩm đang mở.
- Bốn mẫu sản phẩm đã cung cấp được parse đúng.
- Bài lệch cấu trúc không bị suy đoán trường.
- Bảng giao diện cập nhật trước khi Excel đồng bộ.
- Workbook đang mở không gây mất dữ liệu.
- Đóng Excel khiến hàng chờ được đồng bộ tự động.
- Ảnh đại diện hiển thị trong Excel và toàn bộ ảnh mở được từ hyperlink.
- Số tim được cập nhật đúng sau thêm, đổi hoặc gỡ reaction.
- Khởi động lại không làm mất draft, ảnh, reaction hoặc tác vụ Excel.
