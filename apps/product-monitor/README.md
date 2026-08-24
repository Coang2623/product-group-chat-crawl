# Zalo Product Monitor

Ứng dụng local, chỉ đọc dữ liệu từ một nhóm Zalo đã chọn. Mỗi tin mô tả laptop của quản trị viên tạo một sản phẩm; ảnh và lượt tym được cập nhật realtime vào SQLite, sau đó đồng bộ sang workbook Excel theo tháng.

## Chạy lần đầu

Yêu cầu Node.js 18 trở lên.

```powershell
npm install
npm --prefix apps/product-monitor run build
$env:PRODUCT_MONITOR_DATA_DIR = "D:\zalo-product-monitor-data"
npm --prefix apps/product-monitor start
```

Mở `http://127.0.0.1:4173`, tạo mã QR, quét bằng Zalo và chọn đúng một nhóm cần theo dõi.

`PRODUCT_MONITOR_DATA_DIR` phải là đường dẫn tuyệt đối nằm ngoài repository. Thư mục này chứa:

- `products.sqlite`: nguồn dữ liệu chính.
- `zalo-products.xlsx`: workbook được tạo lại an toàn theo dữ liệu SQLite.
- `zalo-products.xlsx.bak`: bản sao workbook trước lần ghi gần nhất.
- `media/`: ảnh sản phẩm, chia theo tháng và ID an toàn.
- `zalo-credentials.json`: phiên đăng nhập local; không commit hoặc chia sẻ file này.

Biến môi trường tùy chọn:

- `PRODUCT_MONITOR_HOST` — mặc định `127.0.0.1`.
- `PRODUCT_MONITOR_PORT` — mặc định `4173`.

## Chạy bằng Docker

Không cần cài Node hay build gì trên máy. Chạy ở thư mục gốc repository:

```powershell
docker compose up -d --build
```

Mở `http://127.0.0.1:4173`, quét QR và chọn nhóm như bình thường.

Dữ liệu nằm trong `./docker-data` trên máy host — database, ảnh, workbook và phiên
đăng nhập Zalo. Container có thể xoá và dựng lại thoải mái, thư mục này giữ nguyên.

```powershell
docker compose logs -f          # xem log
docker compose restart          # khởi động lại
docker compose down             # dừng (dữ liệu vẫn còn)
```

Cổng chỉ mở trên `127.0.0.1`: ứng dụng giữ phiên Zalo đã đăng nhập và không có lớp
đăng nhập riêng, nên không được để máy khác trong mạng truy cập được.

Đổi cổng thì sửa `ports` trong `docker-compose.yml`, không sửa `PRODUCT_MONITOR_PORT`
(cổng bên trong container cố định là 4173).

Các script trong `scripts/` viết bằng TypeScript và cần `tsx` — thứ đã bị loại khỏi
image production. Muốn chạy chúng thì trỏ thẳng vào thư mục dữ liệu của Docker từ máy
host, sau khi đã dừng container để tránh hai tiến trình cùng ghi SQLite:

```powershell
docker compose stop
npx tsx apps/product-monitor/scripts/adopt-orphans.ts --db=docker-data/products.sqlite
docker compose start
```

## Chạy khi phát triển

```powershell
$env:PRODUCT_MONITOR_DATA_DIR = "D:\zalo-product-monitor-dev"
npm --prefix apps/product-monitor run dev
```

Vite chạy frontend và proxy `/api` về server local. Ứng dụng không có composer, không gửi tin nhắn, seen hay reaction về Zalo.

## Kiểm tra

```powershell
npm --prefix apps/product-monitor test
npm --prefix apps/product-monitor run build
npx eslint apps/product-monitor/src apps/product-monitor/test
```

## Recovery và xử lý sự cố

Khi khởi động lại, app tự phục hồi phiên, retry ảnh đang chờ/lỗi, đồng bộ các job Excel bền vững rồi mới bật listener. Chu kỳ retry nền là 10 giây.

- Nếu banner báo Excel đang mở: đóng workbook rồi bấm **Đồng bộ Excel lại ngay**. Dữ liệu realtime vẫn nằm an toàn trong SQLite.
- Nếu QR hết hạn: bấm tạo lại mã và quét lại.
- Nếu đổi nhóm: chọn nhóm trong UI; từ thời điểm đó chỉ tin mới của quản trị viên nhóm vừa chọn được nhận.
- Nếu cần backup: dừng app và sao chép toàn bộ `PRODUCT_MONITOR_DATA_DIR`.
- Khi dừng bằng `Ctrl+C`, listener, HTTP server, timer và SQLite được đóng theo thứ tự.

Không chỉnh trực tiếp SQLite trong lúc app đang chạy. Workbook là đầu ra có thể tái tạo; SQLite và thư mục media mới là dữ liệu cần ưu tiên sao lưu.
