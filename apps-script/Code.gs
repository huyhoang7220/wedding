/**
 * Wedding Invitation — Google Apps Script backend
 * ------------------------------------------------
 * Mỗi lượt xác nhận tham dự = 1 dòng, ghi thẳng vào đúng tab theo mã mời khách nhập.
 *
 * Không chặn theo IP: khách đăng ký bao nhiêu lượt cũng được, mỗi lượt một dòng.
 * IP chỉ được GHI LẠI ở cột IP (do frontend gửi lên) để tham khảo.
 *
 *
 * CÀI ĐẶT
 *  1. Mở Sheet → Tiện ích → Apps Script → dán toàn bộ file này → Ctrl+S
 *  2. Chọn hàm setupSheet → Chạy → cấp quyền
 *  3. Triển khai → Bản triển khai mới → ⚙️ → Ứng dụng web
 *       Thực thi với tư cách:   Tôi
 *       Người có quyền truy cập: Bất kỳ ai
 *  4. Copy URL /exec → dán vào GOOGLE_APP_URL trong index.html
 *
 * Sau MỌI lần sửa file này, phải Triển khai → Quản lý bản triển khai → ✏️ →
 * Phiên bản: Mới → Triển khai. Nếu không, URL cũ vẫn chạy code cũ.
 */

var SPREADSHEET_ID = '15rahZFSv2GaKsuS7xjRcdUC_F1desyuF6CJqiOte5JI';

/** Nhóm khách (khớp passwordGroups ở frontend) → tên tab trong Sheet */
var GROUP_TO_TAB = {
  'Bạn Chú Rể':        'nhà trai',
  'Gia Đình Nhà Trai': 'nhà trai',
  'Bạn Cô Dâu':        'nhà gái',
  'Gia Đình Nhà Gái':  'nhà gái'
};

/** Mã mời lạ / thiếu nhóm → rơi về tab này để không mất dữ liệu khách */
var FALLBACK_TAB = 'nhà trai';

var HEADERS = ['STT', 'Thời gian', 'Họ tên', 'Điện thoại', 'Mã thiệp', 'Nhóm khách', 'Mở album lúc', 'IP', 'Số lần mở', 'Mở album lần đầu'];
var COL = { stt: 1, time: 2, name: 3, phone: 4, code: 5, group: 6, opened: 7, ip: 8, opens: 9, first: 10 };

/** Ô ngày giờ phải ép định dạng, không Sheet chỉ hiện mỗi ngày và giấu mất giờ */
var DATETIME_FORMAT = 'dd/MM/yyyy HH:mm:ss';

/** Tab theo dõi IP — mỗi IP một dòng, cộng dồn số lượt */
var LOG_TAB = 'log ip';
var LOG_HEADERS = ['STT', 'IP', 'Lượt vào trang', 'Lượt xác nhận', 'Lượt mở album',
                   'Lần đầu', 'Gần nhất', 'Nhóm khách', 'Khách liên quan'];
var LOG_COL = { stt: 1, ip: 2, visits: 3, registers: 4, opens: 5,
                first: 6, last: 7, group: 8, guests: 9 };
var UNKNOWN_IP = '(không rõ)';

var WEDDING_DATE = '06/12/2026';   // phải khớp weddingDateDisplay ở frontend
var CODE_LENGTH  = 8;
var ALPHABET     = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // bỏ 0 O 1 I L cho dễ đọc

/* ================================================================== */
/* Entry points                                                        */
/* ================================================================== */

function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');

    switch (body.action) {
      case 'register': return json(handleRegister(body));
      case 'unlock':   return json(handleUnlock(body));
      case 'visit':    return json(handleVisit(body));
      default:         return json({ status: 'error', message: 'Unknown action' });
    }
  } catch (err) {
    return json({ status: 'error', message: 'Server error: ' + err.message });
  }
}

function doGet() {
  return json({ status: 'ok', service: 'wedding-invitation', tabs: tabNames() });
}

/* ================================================================== */
/* Actions                                                             */
/* ================================================================== */

/**
 * { action:'register', name, phone, group, code? } → { status, uniqueCode }
 *
 * Không chặn trùng người: mỗi lượt gửi là một dòng mới, để một người đăng ký hộ
 * nhiều khách trong nhà.
 *
 * NHƯNG chặn trùng LƯỢT GỬI: frontend tự sinh sẵn `code` và gửi kèm. Nếu mã đó
 * đã có trong sheet thì trả lại đúng dòng cũ, không thêm dòng mới. Nhờ vậy khi
 * trình duyệt gửi được nhưng không đọc được phản hồi (CORS) và phải gửi lại,
 * dữ liệu vẫn chỉ vào sheet một lần.
 */
function handleRegister(body) {
  var name  = trim(body.name);
  var phone = trim(body.phone);
  var group = trim(body.group);
  var ip    = trim(body.ip).slice(0, 60);   // chỉ để ghi lại, không dùng để chặn

  if (!name)  return { status: 'error', message: 'Thiếu họ tên / Missing name' };
  if (!phone) return { status: 'error', message: 'Thiếu số điện thoại / Missing phone' };

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);                  // hai khách bấm cùng lúc không nhận trùng mã

  try {
    /* Mã do frontend gửi lên — dùng để chống ghi trùng khi phải gửi lại */
    var code = trim(body.code).toUpperCase();
    if (!/^[A-Z0-9]{6,12}$/.test(code)) code = generateUniqueCode();

    var already = findAcross(COL.code, code, true);
    if (already) {
      return { status: 'success', uniqueCode: code, sheet: already.sheet.getName(), duplicate: true };
    }

    var sheet = tabForGroup(group);
    var stt   = sheet.getLastRow();       // hàng 1 là tiêu đề → STT chạy 1, 2, 3…

    var row = [];
    row[COL.stt    - 1] = stt;
    row[COL.time   - 1] = new Date();
    row[COL.name   - 1] = name;
    row[COL.phone  - 1] = "'" + phone;    // giữ số 0 đứng đầu, không bị đọc thành số
    row[COL.code   - 1] = code;
    row[COL.group  - 1] = group || '(không rõ)';
    row[COL.opened - 1] = '';
    row[COL.ip     - 1] = ip || '(không rõ)';
    row[COL.opens  - 1] = 0;
    row[COL.first  - 1] = '';
    sheet.appendRow(row);

    touchIp(ip, 'register', name, group);

    return { status: 'success', uniqueCode: code, sheet: sheet.getName() };
  } finally {
    lock.releaseLock();
  }
}

/** { action:'unlock', password } → { status } — password = "06/12/2026_CODE" */
function handleUnlock(body) {
  var password = trim(body.password);
  var prefix = WEDDING_DATE + '_';
  var wrong = { status: 'error', message: 'Mật khẩu chưa chính xác / Wrong password' };

  if (password.indexOf(prefix) !== 0) return wrong;

  var code = password.slice(prefix.length).toUpperCase();
  if (!code) return wrong;

  var found = findAcross(COL.code, code, true);
  if (!found) return wrong;

  // Ghi lại lượt mở — chỉ để thống kê, không giới hạn số lần xem
  var now = new Date();
  var sheet = found.sheet;

  // Lần mở gần nhất (ép định dạng để hiện đủ cả giờ phút giây)
  sheet.getRange(found.row, COL.opened).setValue(now).setNumberFormat(DATETIME_FORMAT);

  // Lần mở đầu tiên — chỉ ghi một lần rồi giữ nguyên mãi
  var firstCell = sheet.getRange(found.row, COL.first);
  if (!firstCell.getValue()) firstCell.setValue(now).setNumberFormat(DATETIME_FORMAT);

  // Đếm tổng số lần mở
  var opensCell = sheet.getRange(found.row, COL.opens);
  var opens = Number(opensCell.getValue()) || 0;
  opensCell.setValue(opens + 1);

  touchIp(sheet.getRange(found.row, COL.ip).getValue(),
          'unlock',
          sheet.getRange(found.row, COL.name).getValue(),
          sheet.getRange(found.row, COL.group).getValue());

  return { status: 'success' };
}

/** { action:'visit', ip, group } → { status } — ghi 1 lượt vào trang, không đụng sheet khách */
function handleVisit(body) {
  touchIp(body.ip, 'visit', '', body.group);
  return { status: 'success' };
}

/* ================================================================== */
/* Theo dõi IP                                                         */
/* ================================================================== */

/**
 * Cộng dồn một lượt cho IP vào tab `log ip`.
 * kind: 'visit' (mở trang) | 'register' (xác nhận tham dự) | 'unlock' (mở album)
 * Mỗi IP chỉ có đúng một dòng, nên tab này không phình to theo lượt truy cập.
 */
function touchIp(ip, kind, guestName, group) {
  ip = trim(ip).slice(0, 60) || UNKNOWN_IP;

  var sheet = logSheet();
  var now   = new Date();
  var last  = sheet.getLastRow();
  var row   = 0;

  if (last >= 2) {
    var seen = sheet.getRange(2, LOG_COL.ip, last - 1, 1).getValues();
    for (var i = 0; i < seen.length; i++) {
      if (trim(seen[i][0]) === ip) { row = i + 2; break; }
    }
  }

  if (!row) {
    var fresh = [];
    fresh[LOG_COL.stt       - 1] = Math.max(last, 1);
    fresh[LOG_COL.ip        - 1] = ip;
    fresh[LOG_COL.visits    - 1] = kind === 'visit'    ? 1 : 0;
    fresh[LOG_COL.registers - 1] = kind === 'register' ? 1 : 0;
    fresh[LOG_COL.opens     - 1] = kind === 'unlock'   ? 1 : 0;
    fresh[LOG_COL.first     - 1] = now;
    fresh[LOG_COL.last      - 1] = now;
    fresh[LOG_COL.group     - 1] = trim(group);
    fresh[LOG_COL.guests    - 1] = trim(guestName);
    sheet.appendRow(fresh);
    row = sheet.getLastRow();
    sheet.getRange(row, LOG_COL.first, 1, 2).setNumberFormat(DATETIME_FORMAT);
    return;
  }

  var counter = kind === 'register' ? LOG_COL.registers
              : kind === 'unlock'   ? LOG_COL.opens
              : LOG_COL.visits;
  var cell = sheet.getRange(row, counter);
  cell.setValue((Number(cell.getValue()) || 0) + 1);

  sheet.getRange(row, LOG_COL.last).setValue(now).setNumberFormat(DATETIME_FORMAT);

  if (trim(group)) sheet.getRange(row, LOG_COL.group).setValue(trim(group));

  // Gom tên khách đã dùng IP này, không ghi trùng, cắt bớt cho khỏi tràn ô
  guestName = trim(guestName);
  if (guestName) {
    var guestsCell = sheet.getRange(row, LOG_COL.guests);
    var current = trim(guestsCell.getValue());
    var parts = current ? current.split(' · ') : [];
    var exists = false;
    for (var g = 0; g < parts.length; g++) {
      if (normalize(parts[g]) === normalize(guestName)) { exists = true; break; }
    }
    if (!exists) {
      parts.push(guestName);
      if (parts.length > 12) parts = parts.slice(parts.length - 12);
      guestsCell.setValue(parts.join(' · '));
    }
  }
}

/** Tab `log ip` — tiêu đề riêng, khác hẳn tab danh sách khách */
function logSheet() {
  var ss = book();
  var sheets = ss.getSheets();
  var sheet = null;

  for (var i = 0; i < sheets.length; i++) {
    if (normalize(sheets[i].getName()) === normalize(LOG_TAB)) { sheet = sheets[i]; break; }
  }
  if (!sheet) sheet = ss.insertSheet(LOG_TAB);

  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, LOG_HEADERS.length).setValues([LOG_HEADERS])
         .setFontWeight('bold').setBackground('#F1EDE4');
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(LOG_COL.stt, 50);
    sheet.setColumnWidth(LOG_COL.ip, 150);
    sheet.setColumnWidth(LOG_COL.visits, 110);
    sheet.setColumnWidth(LOG_COL.registers, 110);
    sheet.setColumnWidth(LOG_COL.opens, 110);
    sheet.setColumnWidth(LOG_COL.first, 160);
    sheet.setColumnWidth(LOG_COL.last, 160);
    sheet.setColumnWidth(LOG_COL.group, 160);
    sheet.setColumnWidth(LOG_COL.guests, 280);

    var rows = sheet.getMaxRows() - 1;
    if (rows > 0) {
      sheet.getRange(2, LOG_COL.first, rows, 2).setNumberFormat(DATETIME_FORMAT);
    }
  }
  return sheet;
}

/* ================================================================== */
/* Sheet helpers                                                       */
/* ================================================================== */

function book() {
  try {
    if (SPREADSHEET_ID) return SpreadsheetApp.openById(SPREADSHEET_ID);
  } catch (err) { /* rơi về spreadsheet đang gắn script */ }
  return SpreadsheetApp.getActiveSpreadsheet();
}

/** Danh sách tab được quản lý, không trùng lặp */
function tabNames() {
  var seen = {}, out = [];
  for (var key in GROUP_TO_TAB) {
    var name = GROUP_TO_TAB[key];
    if (!seen[name]) { seen[name] = true; out.push(name); }
  }
  if (!seen[FALLBACK_TAB]) out.push(FALLBACK_TAB);
  return out;
}

/**
 * Lấy tab theo tên, so khớp bỏ qua hoa/thường và khoảng trắng thừa
 * (tab "Nhà Trai" và "nhà trai " vẫn nhận ra là một).
 */
function tab(name) {
  var ss = book();
  var target = normalize(name);
  var sheets = ss.getSheets();

  for (var i = 0; i < sheets.length; i++) {
    if (normalize(sheets[i].getName()) === target) return ensureHeaders(sheets[i]);
  }
  return ensureHeaders(ss.insertSheet(name));
}

function tabForGroup(group) {
  return tab(GROUP_TO_TAB[group] || FALLBACK_TAB);
}

/** Viết tiêu đề nếu tab còn trống — không bao giờ ghi đè dữ liệu sẵn có */
function ensureHeaders(sheet) {
  /* Tab đã có dữ liệu từ trước nhưng chưa có cột IP → bổ sung tiêu đề, giữ nguyên dữ liệu */
  if (sheet.getLastRow() > 0) {
    var width = sheet.getLastColumn();
    if (width < HEADERS.length) {
      var missing = [];
      for (var c = width; c < HEADERS.length; c++) missing.push(HEADERS[c]);
      sheet.getRange(1, width + 1, 1, missing.length).setValues([missing])
           .setFontWeight('bold').setBackground('#F1EDE4');
      sheet.setColumnWidth(COL.ip, 130);
      sheet.setColumnWidth(COL.opens, 90);
      sheet.setColumnWidth(COL.first, 170);
    }
    applyDateFormats(sheet);
    return sheet;
  }

  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS])
         .setFontWeight('bold').setBackground('#F1EDE4');
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 50);
    sheet.setColumnWidth(2, 150);
    sheet.setColumnWidth(3, 200);
    sheet.setColumnWidth(4, 130);
    sheet.setColumnWidth(5, 110);
    sheet.setColumnWidth(6, 170);
    sheet.setColumnWidth(7, 150);
    sheet.setColumnWidth(8, 130);
    sheet.setColumnWidth(9, 90);
    sheet.setColumnWidth(10, 170);
  }
  applyDateFormats(sheet);
  return sheet;
}

/** Ép cột ngày giờ hiện đủ giờ phút giây, kể cả những dòng đã ghi từ trước */
function applyDateFormats(sheet) {
  var rows = sheet.getMaxRows() - 1;
  if (rows < 1) return;
  sheet.getRange(2, COL.time,   rows, 1).setNumberFormat(DATETIME_FORMAT);
  sheet.getRange(2, COL.opened, rows, 1).setNumberFormat(DATETIME_FORMAT);
  sheet.getRange(2, COL.first,  rows, 1).setNumberFormat(DATETIME_FORMAT);
}

/** Tìm giá trị ở một cột, quét toàn bộ các tab được quản lý */
function findAcross(columnIndex, value, caseInsensitive) {
  var names = tabNames();
  var needle = caseInsensitive ? String(value).toUpperCase() : String(value);

  for (var i = 0; i < names.length; i++) {
    var sheet = tab(names[i]);
    var last = sheet.getLastRow();
    if (last < 2) continue;

    var values = sheet.getRange(2, columnIndex, last - 1, 1).getValues();
    for (var r = 0; r < values.length; r++) {
      var cell = trim(values[r][0]);
      if (caseInsensitive) cell = cell.toUpperCase();
      if (cell && cell === needle) return { sheet: sheet, row: r + 2 };
    }
  }
  return null;
}

/** Mã 8 ký tự, không trùng với bất kỳ mã nào đang có ở mọi tab */
function generateUniqueCode() {
  var used = {};
  var names = tabNames();

  for (var i = 0; i < names.length; i++) {
    var sheet = tab(names[i]);
    var last = sheet.getLastRow();
    if (last < 2) continue;
    var values = sheet.getRange(2, COL.code, last - 1, 1).getValues();
    for (var r = 0; r < values.length; r++) used[trim(values[r][0]).toUpperCase()] = true;
  }

  for (var attempt = 0; attempt < 50; attempt++) {
    var code = '';
    for (var c = 0; c < CODE_LENGTH; c++) {
      code += ALPHABET.charAt(Math.floor(Math.random() * ALPHABET.length));
    }
    if (!used[code]) return code;
  }
  return 'X' + String(Date.now()).slice(-7);   // cực hiếm
}

/* ================================================================== */
/* Utils                                                               */
/* ================================================================== */

function trim(value)     { return String(value === null || value === undefined ? '' : value).trim(); }
function normalize(name) { return trim(name).toLowerCase().replace(/\s+/g, ' '); }

function json(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ================================================================== */
/* Chạy tay                                                            */
/* ================================================================== */

/** Chạy 1 lần sau khi dán script: tạo tiêu đề cho các tab */
function setupSheet() {
  var names = tabNames();
  for (var i = 0; i < names.length; i++) tab(names[i]);
  logSheet();
  Logger.log('Đã chuẩn bị xong các tab: ' + names.join(', '));
}

/** Tuỳ chọn: thêm 1 dòng thử để kiểm tra, nhớ xoá sau khi xem */
function testRegister() {
  var out = handleRegister({
    name: 'Nguyễn Văn Test', phone: '0912345678', group: 'Bạn Cô Dâu'
  });
  Logger.log(JSON.stringify(out));
}
