import { HttpError, param } from '../../lib/http.js';

// 开发速查：HTTP 状态码、MIME 类型、常用端口。静态数据，本地查询。
// 只收录标准或广泛使用、含义明确的条目：状态码以 IANA 注册表为准；MIME 以 IANA 注册类型为主，
// 少数没有注册但事实通用的（如 application/x-7z-compressed）照常用写法收录；端口以 IANA 分配和各软件的默认端口为准。

// ---------------- HTTP 状态码 ----------------

const STATUS_CATEGORY = {
  '1xx': '信息响应：请求已收到，继续处理',
  '2xx': '成功：请求已被成功接收、理解并处理',
  '3xx': '重定向：需要客户端进一步操作才能完成请求',
  '4xx': '客户端错误：请求有误或无法被满足',
  '5xx': '服务器错误：服务器处理请求时出错',
};

// [状态码, 英文原因短语, 中文名, 说明, 定义文档]
const STATUS = [
  [100, 'Continue', '继续', '客户端应继续发送请求体。常见于带 Expect: 100-continue 的大文件上传', 'RFC 9110'],
  [101, 'Switching Protocols', '切换协议', '服务器同意按 Upgrade 头切换协议，如升级为 WebSocket', 'RFC 9110'],
  [102, 'Processing', '处理中', 'WebDAV：服务器已收到请求并在处理，尚无响应，防止客户端超时', 'RFC 2518'],
  [103, 'Early Hints', '提前提示', '在最终响应前先返回 Link 头，让浏览器提前预加载资源', 'RFC 8297'],
  [200, 'OK', '成功', '请求成功，响应体中是请求的结果', 'RFC 9110'],
  [201, 'Created', '已创建', '请求成功并创建了新资源，通常用 Location 头给出新资源地址', 'RFC 9110'],
  [202, 'Accepted', '已接受', '请求已接受但尚未处理完成，常用于异步任务', 'RFC 9110'],
  [203, 'Non-Authoritative Information', '非权威信息', '请求成功，但返回的内容被中间代理修改过', 'RFC 9110'],
  [204, 'No Content', '无内容', '请求成功，但没有响应体。常用于 DELETE 或保存操作', 'RFC 9110'],
  [205, 'Reset Content', '重置内容', '请求成功，客户端应重置文档视图（如清空表单）', 'RFC 9110'],
  [206, 'Partial Content', '部分内容', '返回了 Range 请求的部分内容，用于断点续传和分段下载', 'RFC 9110'],
  [207, 'Multi-Status', '多状态', 'WebDAV：响应体（XML）中包含多个资源各自的状态', 'RFC 4918'],
  [208, 'Already Reported', '已报告', 'WebDAV：该资源在之前的多状态响应中已列出，不再重复', 'RFC 5842'],
  [226, 'IM Used', '已应用实例操作', '服务器完成了 GET 请求，响应是对当前实例应用一个或多个实例操作（如增量编码）的结果', 'RFC 3229'],
  [300, 'Multiple Choices', '多种选择', '请求的资源有多种表示形式，客户端可自行选择', 'RFC 9110'],
  [301, 'Moved Permanently', '永久移动', '资源已永久移到 Location 指定的新地址，搜索引擎会更新链接；浏览器可能把 POST 改为 GET', 'RFC 9110'],
  [302, 'Found', '临时移动', '资源临时位于 Location 指定的地址；浏览器可能把 POST 改为 GET', 'RFC 9110'],
  [303, 'See Other', '查看其他位置', '应使用 GET 请求 Location 指定的地址获取结果，常用于表单提交后跳转', 'RFC 9110'],
  [304, 'Not Modified', '未修改', '资源未变化（If-None-Match / If-Modified-Since 条件满足），客户端使用缓存', 'RFC 9110'],
  [305, 'Use Proxy', '使用代理', '已弃用：要求通过 Location 指定的代理访问，出于安全原因浏览器不支持', 'RFC 9110'],
  [307, 'Temporary Redirect', '临时重定向', '临时重定向到 Location，且必须保持原请求方法和请求体', 'RFC 9110'],
  [308, 'Permanent Redirect', '永久重定向', '永久重定向到 Location，且必须保持原请求方法和请求体', 'RFC 9110'],
  [400, 'Bad Request', '错误请求', '请求语法或参数有误，服务器无法处理', 'RFC 9110'],
  [401, 'Unauthorized', '未认证', '需要身份认证或认证失败，响应应带 WWW-Authenticate 头', 'RFC 9110'],
  [402, 'Payment Required', '需要付款', '保留状态码，标准未定义具体用法，部分服务用于表示需付费或额度不足', 'RFC 9110'],
  [403, 'Forbidden', '禁止访问', '服务器理解请求但拒绝执行，通常是没有权限；重新认证也无济于事', 'RFC 9110'],
  [404, 'Not Found', '未找到', '服务器找不到请求的资源', 'RFC 9110'],
  [405, 'Method Not Allowed', '方法不允许', '资源不支持该请求方法，响应须带 Allow 头列出支持的方法', 'RFC 9110'],
  [406, 'Not Acceptable', '无法接受', '无法提供符合 Accept 系列请求头要求的内容', 'RFC 9110'],
  [407, 'Proxy Authentication Required', '需要代理认证', '需要先通过代理服务器的身份认证', 'RFC 9110'],
  [408, 'Request Timeout', '请求超时', '服务器等待客户端发送请求的时间过长', 'RFC 9110'],
  [409, 'Conflict', '冲突', '请求与资源的当前状态冲突，如版本冲突、重复创建', 'RFC 9110'],
  [410, 'Gone', '已删除', '资源已被永久删除且没有新地址', 'RFC 9110'],
  [411, 'Length Required', '需要内容长度', '服务器要求请求带 Content-Length 头', 'RFC 9110'],
  [412, 'Precondition Failed', '前提条件失败', '请求头中的前提条件（如 If-Match）不满足', 'RFC 9110'],
  [413, 'Content Too Large', '请求体过大', '请求体超过服务器允许的大小（旧称 Payload Too Large）', 'RFC 9110'],
  [414, 'URI Too Long', '网址过长', '请求的 URI 超过服务器能处理的长度', 'RFC 9110'],
  [415, 'Unsupported Media Type', '不支持的媒体类型', '请求体的格式（Content-Type）不被支持', 'RFC 9110'],
  [416, 'Range Not Satisfiable', '范围无法满足', 'Range 请求头指定的范围超出资源大小', 'RFC 9110'],
  [417, 'Expectation Failed', '预期失败', '服务器无法满足 Expect 请求头的要求', 'RFC 9110'],
  [418, "I'm a teapot", '我是茶壶', '源自 1998 年愚人节 RFC 2324 的玩笑，现被保留、不得分配他用；部分服务用它拒绝请求', 'RFC 9110'],
  [421, 'Misdirected Request', '请求发错服务器', '请求被发往无法生成响应的服务器，常见于 HTTP/2 连接复用到了不对应的域名', 'RFC 9110'],
  [422, 'Unprocessable Content', '无法处理的内容', '请求格式正确但语义有误，如字段校验失败（旧称 Unprocessable Entity）', 'RFC 9110'],
  [423, 'Locked', '已锁定', 'WebDAV：资源被锁定', 'RFC 4918'],
  [424, 'Failed Dependency', '依赖失败', 'WebDAV：因依赖的另一个操作失败，本操作也失败', 'RFC 4918'],
  [425, 'Too Early', '为时过早', '服务器不愿处理可能被重放的请求（如 TLS 1.3 的 0-RTT 早期数据）', 'RFC 8470'],
  [426, 'Upgrade Required', '需要升级协议', '客户端须切换到 Upgrade 头指定的协议（如 TLS）后才能访问', 'RFC 9110'],
  [428, 'Precondition Required', '需要前提条件', '服务器要求请求带条件头（如 If-Match），防止“丢失更新”', 'RFC 6585'],
  [429, 'Too Many Requests', '请求过多', '客户端在一定时间内请求次数过多被限流，可带 Retry-After 头', 'RFC 6585'],
  [431, 'Request Header Fields Too Large', '请求头过大', '单个请求头或全部请求头过大，服务器拒绝处理', 'RFC 6585'],
  [451, 'Unavailable For Legal Reasons', '因法律原因不可用', '因法律要求（如政府审查、版权）无法提供该资源', 'RFC 7725'],
  [500, 'Internal Server Error', '服务器内部错误', '服务器遇到意外情况，无法完成请求', 'RFC 9110'],
  [501, 'Not Implemented', '未实现', '服务器不支持完成请求所需的功能，如无法识别请求方法', 'RFC 9110'],
  [502, 'Bad Gateway', '网关错误', '网关或代理从上游服务器收到了无效响应', 'RFC 9110'],
  [503, 'Service Unavailable', '服务不可用', '服务器暂时过载或停机维护，可带 Retry-After 头', 'RFC 9110'],
  [504, 'Gateway Timeout', '网关超时', '网关或代理未能及时从上游服务器收到响应', 'RFC 9110'],
  [505, 'HTTP Version Not Supported', 'HTTP 版本不支持', '服务器不支持请求使用的 HTTP 版本', 'RFC 9110'],
  [506, 'Variant Also Negotiates', '变体也在协商', '内容协商配置错误：选中的变体本身也要协商，形成循环', 'RFC 2295'],
  [507, 'Insufficient Storage', '存储空间不足', 'WebDAV：服务器无法存储完成请求所需的内容', 'RFC 4918'],
  [508, 'Loop Detected', '检测到循环', 'WebDAV：处理请求时检测到无限循环', 'RFC 5842'],
  [510, 'Not Extended', '未扩展', '请求需要进一步扩展才能被处理（RFC 2774 已被 IETF 列为历史文档）', 'RFC 2774'],
  [511, 'Network Authentication Required', '需要网络认证', '需要先进行网络认证才能访问，常见于公共 Wi-Fi 的登录页（强制门户）', 'RFC 6585'],
].map(([code, name, nameZh, description, spec]) => {
  const category = `${String(code)[0]}xx`;
  return { code, name, nameZh, description, category, categoryDesc: STATUS_CATEGORY[category], spec };
});

// ---------------- MIME 类型 ----------------

// [扩展名, MIME 类型, 中文说明]
const MIME = [
  // 文本 / 网页 / 数据
  ['txt', 'text/plain', '纯文本'],
  ['html', 'text/html', 'HTML 网页'],
  ['htm', 'text/html', 'HTML 网页'],
  ['css', 'text/css', 'CSS 样式表'],
  ['js', 'text/javascript', 'JavaScript 脚本（RFC 9239 推荐 text/javascript，旧写法 application/javascript）'],
  ['mjs', 'text/javascript', 'JavaScript 模块（ES Module）'],
  ['json', 'application/json', 'JSON 数据'],
  ['jsonld', 'application/ld+json', 'JSON-LD 结构化数据'],
  ['geojson', 'application/geo+json', 'GeoJSON 地理数据'],
  ['ndjson', 'application/x-ndjson', '换行分隔的 JSON（每行一个 JSON，非 IANA 注册）'],
  ['map', 'application/json', 'Source Map 源码映射（JSON 格式）'],
  ['webmanifest', 'application/manifest+json', 'Web 应用清单（PWA）'],
  ['xml', 'application/xml', 'XML 文档（也常用 text/xml）'],
  ['xsl', 'application/xslt+xml', 'XSLT 样式表'],
  ['xslt', 'application/xslt+xml', 'XSLT 样式表'],
  ['dtd', 'application/xml-dtd', 'XML 文档类型定义'],
  ['xhtml', 'application/xhtml+xml', 'XHTML 网页'],
  ['rss', 'application/rss+xml', 'RSS 订阅源'],
  ['atom', 'application/atom+xml', 'Atom 订阅源'],
  ['csv', 'text/csv', '逗号分隔值表格'],
  ['tsv', 'text/tab-separated-values', '制表符分隔值表格'],
  ['md', 'text/markdown', 'Markdown 文档'],
  ['markdown', 'text/markdown', 'Markdown 文档'],
  ['yaml', 'application/yaml', 'YAML 数据（RFC 9512）'],
  ['yml', 'application/yaml', 'YAML 数据（RFC 9512）'],
  ['ics', 'text/calendar', 'iCalendar 日历'],
  ['vcf', 'text/vcard', 'vCard 电子名片'],
  ['vtt', 'text/vtt', 'WebVTT 字幕'],
  ['srt', 'application/x-subrip', 'SubRip 字幕（非 IANA 注册）'],
  ['rtf', 'application/rtf', '富文本格式'],
  ['sql', 'application/sql', 'SQL 脚本'],
  ['wasm', 'application/wasm', 'WebAssembly 二进制模块'],
  ['sh', 'application/x-sh', 'Shell 脚本'],
  ['csh', 'application/x-csh', 'C Shell 脚本'],
  ['php', 'application/x-httpd-php', 'PHP 源文件'],
  ['py', 'text/x-python', 'Python 源文件（非 IANA 注册）'],
  ['c', 'text/x-c', 'C 源文件（非 IANA 注册）'],
  ['h', 'text/x-c', 'C 头文件（非 IANA 注册）'],
  // 图片
  ['png', 'image/png', 'PNG 图片'],
  ['apng', 'image/apng', 'APNG 动画 PNG'],
  ['jpg', 'image/jpeg', 'JPEG 图片'],
  ['jpeg', 'image/jpeg', 'JPEG 图片'],
  ['jfif', 'image/jpeg', 'JPEG 图片（JFIF）'],
  ['gif', 'image/gif', 'GIF 图片 / 动图'],
  ['webp', 'image/webp', 'WebP 图片'],
  ['avif', 'image/avif', 'AVIF 图片'],
  ['heic', 'image/heic', 'HEIC 图片（苹果设备常用）'],
  ['heif', 'image/heif', 'HEIF 图片'],
  ['svg', 'image/svg+xml', 'SVG 矢量图'],
  ['svgz', 'image/svg+xml', 'gzip 压缩的 SVG（需配合 Content-Encoding: gzip）'],
  ['bmp', 'image/bmp', 'BMP 位图'],
  ['ico', 'image/vnd.microsoft.icon', 'ICO 图标（也常用 image/x-icon）'],
  ['tif', 'image/tiff', 'TIFF 图片'],
  ['tiff', 'image/tiff', 'TIFF 图片'],
  ['jp2', 'image/jp2', 'JPEG 2000 图片'],
  ['psd', 'image/vnd.adobe.photoshop', 'Photoshop 文档'],
  ['dwg', 'image/vnd.dwg', 'AutoCAD 图纸'],
  ['dxf', 'image/vnd.dxf', 'AutoCAD 交换格式'],
  // 音频
  ['mp3', 'audio/mpeg', 'MP3 音频'],
  ['wav', 'audio/wav', 'WAV 音频（也见 audio/x-wav、audio/vnd.wave）'],
  ['aac', 'audio/aac', 'AAC 音频'],
  ['m4a', 'audio/mp4', 'MPEG-4 音频'],
  ['flac', 'audio/flac', 'FLAC 无损音频'],
  ['ogg', 'audio/ogg', 'Ogg 音频'],
  ['oga', 'audio/ogg', 'Ogg 音频'],
  ['opus', 'audio/ogg', 'Opus 音频（Ogg 封装）'],
  ['weba', 'audio/webm', 'WebM 音频'],
  ['mid', 'audio/midi', 'MIDI 音乐（也见 audio/x-midi）'],
  ['midi', 'audio/midi', 'MIDI 音乐（也见 audio/x-midi）'],
  ['amr', 'audio/amr', 'AMR 语音'],
  ['wma', 'audio/x-ms-wma', 'Windows Media 音频'],
  ['aif', 'audio/x-aiff', 'AIFF 音频'],
  ['aiff', 'audio/x-aiff', 'AIFF 音频'],
  ['m3u', 'audio/x-mpegurl', 'M3U 播放列表'],
  // 视频
  ['mp4', 'video/mp4', 'MP4 视频'],
  ['m4v', 'video/x-m4v', 'M4V 视频（苹果）'],
  ['webm', 'video/webm', 'WebM 视频'],
  ['ogv', 'video/ogg', 'Ogg 视频'],
  ['mov', 'video/quicktime', 'QuickTime 视频'],
  ['avi', 'video/x-msvideo', 'AVI 视频'],
  ['wmv', 'video/x-ms-wmv', 'Windows Media 视频'],
  ['flv', 'video/x-flv', 'Flash 视频'],
  ['mkv', 'video/x-matroska', 'Matroska 视频'],
  ['mpeg', 'video/mpeg', 'MPEG 视频'],
  ['mpg', 'video/mpeg', 'MPEG 视频'],
  ['ts', 'video/mp2t', 'MPEG-2 传输流（HLS 分片；注意不是 TypeScript）'],
  ['3gp', 'video/3gpp', '3GPP 视频（音频文件时为 audio/3gpp）'],
  ['3g2', 'video/3gpp2', '3GPP2 视频（音频文件时为 audio/3gpp2）'],
  ['m3u8', 'application/vnd.apple.mpegurl', 'HLS 播放列表'],
  ['mpd', 'application/dash+xml', 'MPEG-DASH 清单'],
  // 字体
  ['woff', 'font/woff', 'WOFF 网页字体'],
  ['woff2', 'font/woff2', 'WOFF2 网页字体'],
  ['ttf', 'font/ttf', 'TrueType 字体'],
  ['otf', 'font/otf', 'OpenType 字体'],
  ['ttc', 'font/collection', 'TrueType 字体集'],
  ['eot', 'application/vnd.ms-fontobject', 'Embedded OpenType 字体（旧版 IE）'],
  // 文档 / 办公
  ['pdf', 'application/pdf', 'PDF 文档'],
  ['doc', 'application/msword', 'Word 97-2003 文档'],
  ['dot', 'application/msword', 'Word 97-2003 模板'],
  ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'Word 文档'],
  ['dotx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.template', 'Word 模板'],
  ['docm', 'application/vnd.ms-word.document.macroEnabled.12', '启用宏的 Word 文档'],
  ['xls', 'application/vnd.ms-excel', 'Excel 97-2003 工作簿'],
  ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Excel 工作簿'],
  ['xltx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.template', 'Excel 模板'],
  ['xlsm', 'application/vnd.ms-excel.sheet.macroEnabled.12', '启用宏的 Excel 工作簿'],
  ['xlsb', 'application/vnd.ms-excel.sheet.binary.macroEnabled.12', 'Excel 二进制工作簿'],
  ['ppt', 'application/vnd.ms-powerpoint', 'PowerPoint 97-2003 演示文稿'],
  ['pps', 'application/vnd.ms-powerpoint', 'PowerPoint 97-2003 放映文件'],
  ['pot', 'application/vnd.ms-powerpoint', 'PowerPoint 97-2003 模板'],
  ['pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'PowerPoint 演示文稿'],
  ['ppsx', 'application/vnd.openxmlformats-officedocument.presentationml.slideshow', 'PowerPoint 放映文件'],
  ['potx', 'application/vnd.openxmlformats-officedocument.presentationml.template', 'PowerPoint 模板'],
  ['pptm', 'application/vnd.ms-powerpoint.presentation.macroEnabled.12', '启用宏的 PowerPoint 演示文稿'],
  ['odt', 'application/vnd.oasis.opendocument.text', 'OpenDocument 文本'],
  ['ods', 'application/vnd.oasis.opendocument.spreadsheet', 'OpenDocument 电子表格'],
  ['odp', 'application/vnd.oasis.opendocument.presentation', 'OpenDocument 演示文稿'],
  ['odg', 'application/vnd.oasis.opendocument.graphics', 'OpenDocument 绘图'],
  ['pages', 'application/vnd.apple.pages', 'Apple Pages 文稿'],
  ['numbers', 'application/vnd.apple.numbers', 'Apple Numbers 表格'],
  ['key', 'application/vnd.apple.keynote', 'Apple Keynote 演示文稿（注意 .key 也常用作私钥文件扩展名）'],
  ['vsd', 'application/vnd.visio', 'Visio 绘图'],
  ['xps', 'application/vnd.ms-xpsdocument', 'XPS 文档'],
  ['chm', 'application/vnd.ms-htmlhelp', 'Windows 帮助文件'],
  ['epub', 'application/epub+zip', 'EPUB 电子书'],
  ['mobi', 'application/x-mobipocket-ebook', 'Mobipocket 电子书'],
  ['azw', 'application/vnd.amazon.ebook', 'Kindle 电子书'],
  ['abw', 'application/x-abiword', 'AbiWord 文档'],
  ['ps', 'application/postscript', 'PostScript'],
  ['eps', 'application/postscript', 'EPS 矢量图'],
  // 压缩包 / 安装包 / 二进制
  ['zip', 'application/zip', 'ZIP 压缩包'],
  ['gz', 'application/gzip', 'gzip 压缩文件'],
  ['tgz', 'application/gzip', 'gzip 压缩的 tar 包'],
  ['tar', 'application/x-tar', 'tar 归档'],
  ['bz', 'application/x-bzip', 'bzip 压缩文件'],
  ['bz2', 'application/x-bzip2', 'bzip2 压缩文件'],
  ['xz', 'application/x-xz', 'xz 压缩文件'],
  ['zst', 'application/zstd', 'Zstandard 压缩文件'],
  ['7z', 'application/x-7z-compressed', '7-Zip 压缩包'],
  ['rar', 'application/vnd.rar', 'RAR 压缩包（旧写法 application/x-rar-compressed）'],
  ['arc', 'application/x-freearc', 'FreeArc 归档'],
  ['jar', 'application/java-archive', 'Java 归档'],
  ['apk', 'application/vnd.android.package-archive', 'Android 安装包'],
  ['exe', 'application/vnd.microsoft.portable-executable', 'Windows 可执行文件（也常用 application/x-msdownload）'],
  ['msi', 'application/x-msdownload', 'Windows 安装包（也见 application/x-msi）'],
  ['dmg', 'application/x-apple-diskimage', 'macOS 磁盘映像'],
  ['deb', 'application/vnd.debian.binary-package', 'Debian / Ubuntu 软件包'],
  ['rpm', 'application/x-rpm', 'RPM 软件包'],
  ['iso', 'application/x-iso9660-image', '光盘映像'],
  ['mpkg', 'application/vnd.apple.installer+xml', 'Apple 安装包'],
  ['bin', 'application/octet-stream', '任意二进制数据（未知类型的默认值）'],
  ['swf', 'application/x-shockwave-flash', 'Flash 动画（已淘汰）'],
  ['torrent', 'application/x-bittorrent', 'BT 种子'],
  ['ogx', 'application/ogg', 'Ogg 容器'],
  ['xul', 'application/vnd.mozilla.xul+xml', 'Mozilla XUL 界面描述'],
  // 证书 / 密钥
  ['cer', 'application/pkix-cert', 'X.509 证书（DER）'],
  ['crl', 'application/pkix-crl', '证书吊销列表'],
  ['p7s', 'application/pkcs7-signature', 'PKCS#7 签名'],
  ['p7m', 'application/pkcs7-mime', 'PKCS#7 加密 / 签名消息'],
  ['p10', 'application/pkcs10', 'PKCS#10 证书签名请求'],
  ['p12', 'application/x-pkcs12', 'PKCS#12 证书包（含私钥）'],
  ['pfx', 'application/x-pkcs12', 'PKCS#12 证书包（含私钥）'],
  ['crt', 'application/x-x509-ca-cert', 'X.509 证书'],
  ['asc', 'application/pgp-signature', 'PGP 签名（ASCII）'],
  ['sig', 'application/pgp-signature', 'PGP 签名'],
  // 地图
  ['kml', 'application/vnd.google-earth.kml+xml', 'Google Earth KML'],
  ['kmz', 'application/vnd.google-earth.kmz', 'Google Earth KMZ'],
  ['gpx', 'application/gpx+xml', 'GPS 轨迹'],
].map(([ext, type, desc]) => ({ ext, type, category: type.split('/')[0], desc }));

// ---------------- 端口 ----------------

// [端口, 协议, 服务名, 中文说明]
const PORTS = [
  [20, 'tcp', 'ftp-data', 'FTP 数据传输（主动模式）'],
  [21, 'tcp', 'ftp', 'FTP 控制连接'],
  [22, 'tcp', 'ssh', 'SSH 远程登录，SFTP、SCP 也走此端口'],
  [23, 'tcp', 'telnet', 'Telnet 远程登录（明文，不安全）'],
  [25, 'tcp', 'smtp', 'SMTP 邮件传输（服务器之间投递）'],
  [53, 'tcp/udp', 'dns', 'DNS 域名解析'],
  [67, 'udp', 'bootps', 'DHCP 服务器（BOOTP 服务端）'],
  [68, 'udp', 'bootpc', 'DHCP 客户端（BOOTP 客户端）'],
  [69, 'udp', 'tftp', 'TFTP 简单文件传输'],
  [80, 'tcp', 'http', 'HTTP 网页'],
  [88, 'tcp/udp', 'kerberos', 'Kerberos 认证'],
  [110, 'tcp', 'pop3', 'POP3 收邮件'],
  [111, 'tcp/udp', 'rpcbind', 'ONC RPC 端口映射（portmapper），NFS 依赖'],
  [119, 'tcp', 'nntp', 'NNTP 新闻组'],
  [123, 'udp', 'ntp', 'NTP 网络时间同步'],
  [135, 'tcp', 'epmap', 'Windows RPC 端点映射（MSRPC）'],
  [137, 'udp', 'netbios-ns', 'NetBIOS 名称服务'],
  [138, 'udp', 'netbios-dgm', 'NetBIOS 数据报服务'],
  [139, 'tcp', 'netbios-ssn', 'NetBIOS 会话服务（旧版 SMB 文件共享）'],
  [143, 'tcp', 'imap', 'IMAP 收邮件'],
  [161, 'udp', 'snmp', 'SNMP 网络管理'],
  [162, 'udp', 'snmptrap', 'SNMP Trap 告警'],
  [179, 'tcp', 'bgp', 'BGP 边界网关协议'],
  [389, 'tcp/udp', 'ldap', 'LDAP 目录服务'],
  [443, 'tcp/udp', 'https', 'HTTPS 网页（UDP 443 用于 HTTP/3 / QUIC）'],
  [445, 'tcp', 'microsoft-ds', 'SMB 文件共享（Windows 共享、Samba）'],
  [465, 'tcp', 'submissions', 'SMTP over TLS 发邮件（隐式 TLS）'],
  [500, 'udp', 'isakmp', 'IPsec IKE 密钥交换'],
  [514, 'udp', 'syslog', 'Syslog 日志'],
  [515, 'tcp', 'printer', 'LPD 行式打印机'],
  [520, 'udp', 'rip', 'RIP 路由协议'],
  [546, 'udp', 'dhcpv6-client', 'DHCPv6 客户端'],
  [547, 'udp', 'dhcpv6-server', 'DHCPv6 服务器'],
  [554, 'tcp/udp', 'rtsp', 'RTSP 实时流媒体（网络摄像头常用）'],
  [587, 'tcp', 'submission', '邮件提交（客户端发邮件，通常配合 STARTTLS）'],
  [631, 'tcp', 'ipp', 'IPP 互联网打印（CUPS）'],
  [636, 'tcp', 'ldaps', 'LDAP over TLS'],
  [853, 'tcp/udp', 'domain-s', 'DNS over TLS（TCP）/ DNS over QUIC（UDP）'],
  [873, 'tcp', 'rsync', 'rsync 文件同步'],
  [989, 'tcp', 'ftps-data', 'FTPS 数据连接（隐式 TLS）'],
  [990, 'tcp', 'ftps', 'FTPS 控制连接（隐式 TLS）'],
  [993, 'tcp', 'imaps', 'IMAP over TLS'],
  [995, 'tcp', 'pop3s', 'POP3 over TLS'],
  [1080, 'tcp', 'socks', 'SOCKS 代理'],
  [1194, 'tcp/udp', 'openvpn', 'OpenVPN（默认 UDP）'],
  [1433, 'tcp', 'ms-sql-s', 'Microsoft SQL Server'],
  [1434, 'udp', 'ms-sql-m', 'SQL Server Browser（实例发现）'],
  [1521, 'tcp', 'oracle', 'Oracle 数据库监听'],
  [1701, 'udp', 'l2tp', 'L2TP VPN'],
  [1723, 'tcp', 'pptp', 'PPTP VPN（已不安全）'],
  [1812, 'udp', 'radius', 'RADIUS 认证'],
  [1813, 'udp', 'radius-acct', 'RADIUS 计费'],
  [1883, 'tcp', 'mqtt', 'MQTT 物联网消息（明文）'],
  [1900, 'udp', 'ssdp', 'SSDP / UPnP 设备发现'],
  [2049, 'tcp/udp', 'nfs', 'NFS 网络文件系统'],
  [2181, 'tcp', 'zookeeper', 'ZooKeeper 客户端端口'],
  [2375, 'tcp', 'docker', 'Docker 守护进程 API（未加密，切勿暴露到公网）'],
  [2376, 'tcp', 'docker-s', 'Docker 守护进程 API（TLS）'],
  [2377, 'tcp', 'swarm', 'Docker Swarm 集群管理'],
  [2379, 'tcp', 'etcd-client', 'etcd 客户端 API'],
  [2380, 'tcp', 'etcd-server', 'etcd 节点间通信'],
  [3000, 'tcp', 'grafana', 'Grafana 默认端口；也常被 Node.js 等开发服务器使用'],
  [3128, 'tcp', 'squid', 'Squid HTTP 代理'],
  [3268, 'tcp', 'msft-gc', 'Active Directory 全局编录（LDAP）'],
  [3306, 'tcp', 'mysql', 'MySQL / MariaDB 数据库'],
  [3389, 'tcp/udp', 'ms-wbt-server', 'Windows 远程桌面（RDP）'],
  [3478, 'tcp/udp', 'stun', 'STUN / TURN（WebRTC 穿透）'],
  [4369, 'tcp', 'epmd', 'Erlang 端口映射（RabbitMQ 集群依赖）'],
  [4500, 'udp', 'ipsec-nat-t', 'IPsec NAT 穿透'],
  [4789, 'udp', 'vxlan', 'VXLAN 隧道'],
  [5044, 'tcp', 'beats', 'Logstash Beats 输入'],
  [5060, 'tcp/udp', 'sip', 'SIP 网络电话信令'],
  [5061, 'tcp', 'sips', 'SIP over TLS'],
  [5222, 'tcp', 'xmpp-client', 'XMPP 客户端连接'],
  [5269, 'tcp', 'xmpp-server', 'XMPP 服务器间通信'],
  [5353, 'udp', 'mdns', 'mDNS 局域网服务发现（Bonjour）'],
  [5355, 'udp', 'llmnr', 'LLMNR 链路本地名称解析（Windows）'],
  [5432, 'tcp', 'postgresql', 'PostgreSQL 数据库'],
  [5601, 'tcp', 'kibana', 'Kibana 网页界面'],
  [5671, 'tcp', 'amqps', 'AMQP over TLS'],
  [5672, 'tcp', 'amqp', 'AMQP 消息队列（RabbitMQ）'],
  [5900, 'tcp', 'vnc', 'VNC 远程桌面（显示器 :0）'],
  [5984, 'tcp', 'couchdb', 'CouchDB 数据库'],
  [5985, 'tcp', 'wsman', 'WinRM 远程管理（HTTP）'],
  [5986, 'tcp', 'wsmans', 'WinRM 远程管理（HTTPS）'],
  [6379, 'tcp', 'redis', 'Redis 数据库'],
  [6443, 'tcp', 'kube-apiserver', 'Kubernetes API Server'],
  [6667, 'tcp', 'irc', 'IRC 聊天'],
  [6697, 'tcp', 'ircs', 'IRC over TLS'],
  [6881, 'tcp/udp', 'bittorrent', 'BitTorrent（常用 6881~6889）'],
  [7474, 'tcp', 'neo4j', 'Neo4j 图数据库 HTTP'],
  [8005, 'tcp', 'tomcat-shutdown', 'Tomcat 关闭端口'],
  [8009, 'tcp', 'ajp13', 'AJP 协议（Tomcat 连接器）'],
  [8080, 'tcp', 'http-alt', 'HTTP 备用端口，常用于代理、Tomcat、开发服务器'],
  [8086, 'tcp', 'influxdb', 'InfluxDB HTTP API'],
  [8200, 'tcp', 'vault', 'HashiCorp Vault'],
  [8443, 'tcp', 'https-alt', 'HTTPS 备用端口'],
  [8500, 'tcp', 'consul', 'Consul HTTP API'],
  [8883, 'tcp', 'secure-mqtt', 'MQTT over TLS'],
  [9042, 'tcp', 'cassandra', 'Cassandra CQL'],
  [9090, 'tcp', 'prometheus', 'Prometheus 服务'],
  [9092, 'tcp', 'kafka', 'Kafka 消息队列'],
  [9093, 'tcp', 'alertmanager', 'Prometheus Alertmanager'],
  [9200, 'tcp', 'elasticsearch', 'Elasticsearch HTTP API'],
  [9300, 'tcp', 'elasticsearch-transport', 'Elasticsearch 节点间通信'],
  [9418, 'tcp', 'git', 'Git 协议（git://）'],
  [10250, 'tcp', 'kubelet', 'Kubernetes kubelet API'],
  [11211, 'tcp', 'memcache', 'Memcached 缓存（UDP 已默认关闭，防反射放大攻击）'],
  [15672, 'tcp', 'rabbitmq-mgmt', 'RabbitMQ 管理界面'],
  [25565, 'tcp', 'minecraft', 'Minecraft Java 版服务器'],
  [27017, 'tcp', 'mongodb', 'MongoDB 数据库'],
  [51820, 'udp', 'wireguard', 'WireGuard VPN（常用默认值）'],
].map(([port, protocol, service, description]) => ({
  port,
  protocol,
  service,
  description,
  range: port < 1024 ? 'well-known' : port < 49152 ? 'registered' : 'dynamic',
}));

// ---------------- 查询 ----------------

// 模糊搜索：关键字按空白拆开，每个词都要在任一字段中出现（不区分大小写）
function search(list, q, keys) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return list.filter((item) => words.every((w) => keys.some((k) => String(item[k]).toLowerCase().includes(w))));
}

const result = (items) => ({ total: items.length, items });

export function lookupStatus({ code, q } = {}) {
  let items = STATUS;
  if (code) {
    if (/^[1-5]xx$/i.test(code)) items = items.filter((s) => s.category === code.toLowerCase());
    else if (/^\d{3}$/.test(code)) {
      items = items.filter((s) => s.code === Number(code));
      if (!items.length) throw new HttpError(404, `未收录状态码 ${code}（不是标准 HTTP 状态码）`);
    } else throw new HttpError(400, 'code 须为三位数字（如 404）或类别（如 4xx）');
  }
  if (q) items = search(items, q, ['code', 'name', 'nameZh', 'description', 'categoryDesc']);
  return result(items);
}

export function lookupMime({ ext, type, q } = {}) {
  let items = MIME;
  if (ext) {
    const e = ext.trim().toLowerCase().replace(/^.*\./, '');
    items = items.filter((m) => m.ext === e);
    if (!items.length) throw new HttpError(404, `未收录扩展名 .${e}`);
  }
  if (type) {
    const t = type.trim().toLowerCase().split(';')[0].trim();
    items = items.filter((m) => m.type.toLowerCase() === t);
    if (!items.length) throw new HttpError(404, `未收录 MIME 类型 ${t}`);
  }
  if (q) items = search(items, q, ['ext', 'type', 'desc']);
  return result(items);
}

export function lookupPort({ port, protocol, q } = {}) {
  let items = PORTS;
  if (port != null) {
    items = items.filter((p) => p.port === port);
    if (!items.length) throw new HttpError(404, `未收录端口 ${port}`);
  }
  if (protocol) items = items.filter((p) => p.protocol.split('/').includes(protocol));
  if (q) items = search(items, q, ['port', 'service', 'description']);
  return result(items);
}

export const DATA = { STATUS, MIME, PORTS };

// ---------------- 路由 ----------------

const Q_PARAM = (example) => ({ name: 'q', required: false, desc: '模糊搜索关键字，多个词用空格分隔（每个词都须匹配，不区分大小写）', example });

export default {
  name: 'devref',
  category: 'tools',
  title: '开发速查',
  description: 'HTTP 状态码、MIME 类型（文件扩展名）、常用端口速查，支持精确查询和模糊搜索',
  source: '本地数据（IANA 注册表及常见软件默认值）',
  routes: [
    {
      method: 'GET',
      path: '/api/devref/http-status',
      summary: `HTTP 状态码速查：共 ${STATUS.length} 个标准状态码，附中文名称与说明`,
      params: [
        { name: 'code', required: false, desc: '状态码（如 404）或类别（1xx~5xx）；不传返回全部。三位数字查不到时返回 404', example: '404' },
        Q_PARAM('找不到'),
      ],
      fields: [
        { name: 'total', type: 'number', desc: '匹配条数' },
        { name: 'items', type: 'array', desc: '匹配的状态码，按数字升序' },
        { name: 'items[].code', type: 'number', desc: '状态码' },
        { name: 'items[].name', type: 'string', desc: '英文原因短语（IANA 注册名），如 Not Found' },
        { name: 'items[].nameZh', type: 'string', desc: '中文名称' },
        { name: 'items[].description', type: 'string', desc: '中文说明' },
        { name: 'items[].category', type: 'string', desc: '类别：1xx / 2xx / 3xx / 4xx / 5xx' },
        { name: 'items[].categoryDesc', type: 'string', desc: '类别的中文说明' },
        { name: 'items[].spec', type: 'string', desc: '定义该状态码的规范，如 RFC 9110' },
      ],
      async handler({ query }) {
        const code = param(query, 'code', { max: 3 });
        const q = param(query, 'q', { max: 50 });
        return { data: lookupStatus({ code, q }) };
      },
    },
    {
      method: 'GET',
      path: '/api/devref/mime',
      summary: `MIME 类型速查：${MIME.length} 个常见扩展名与 MIME 类型互查`,
      params: [
        { name: 'ext', required: false, desc: '文件扩展名（带不带点都行，也可以是文件名，如 report.PDF）；查不到时返回 404', example: 'png' },
        { name: 'type', required: false, desc: 'MIME 类型，如 application/json（忽略 ; 之后的参数），返回所有对应的扩展名；查不到时返回 404', example: 'image/png' },
        Q_PARAM('图片'),
      ],
      fields: [
        { name: 'total', type: 'number', desc: '匹配条数' },
        { name: 'items', type: 'array', desc: '匹配的扩展名与类型，同一类型可能对应多个扩展名' },
        { name: 'items[].ext', type: 'string', desc: '扩展名（小写，不带点）' },
        { name: 'items[].type', type: 'string', desc: 'MIME 类型（Content-Type 的值）' },
        { name: 'items[].category', type: 'string', desc: '顶级类型：text / image / audio / video / font / application' },
        { name: 'items[].desc', type: 'string', desc: '中文说明；非 IANA 注册但通用的类型会注明' },
      ],
      async handler({ query }) {
        const ext = param(query, 'ext', { max: 100 });
        const type = param(query, 'type', { max: 200 });
        const q = param(query, 'q', { max: 50 });
        return { data: lookupMime({ ext, type, q }) };
      },
    },
    {
      method: 'GET',
      path: '/api/devref/port',
      summary: `常用端口速查：${PORTS.length} 个知名服务端口及协议`,
      params: [
        { name: 'port', required: false, desc: '端口号 1~65535；查不到时返回 404', example: '3306' },
        { name: 'protocol', required: false, desc: '只看某种传输协议：tcp / udp', example: 'tcp' },
        Q_PARAM('数据库'),
      ],
      fields: [
        { name: 'total', type: 'number', desc: '匹配条数' },
        { name: 'items', type: 'array', desc: '匹配的端口，按端口号升序' },
        { name: 'items[].port', type: 'number', desc: '端口号' },
        { name: 'items[].protocol', type: 'string', desc: '传输协议：tcp / udp / tcp/udp' },
        { name: 'items[].service', type: 'string', desc: '服务名（多为 IANA 服务名，没有注册名的用软件名）' },
        { name: 'items[].description', type: 'string', desc: '中文说明' },
        { name: 'items[].range', type: 'string', desc: '端口段：well-known（0~1023 系统端口）/ registered（1024~49151 注册端口）/ dynamic（49152~65535 动态端口）' },
      ],
      async handler({ query }) {
        const port = param(query, 'port', { int: true, min: 1, max: 65535 });
        const protocol = param(query, 'protocol', { oneOf: ['tcp', 'udp'] });
        const q = param(query, 'q', { max: 50 });
        return { data: lookupPort({ port, protocol, q }) };
      },
    },
  ],
};
