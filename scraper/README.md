# RentSmart AI — 爬虫后端服务

基于 **DrissionPage + Flask** 的本地 HTTP 服务，为 RentSmart AI App 提供安居客与贝壳租房数据抓取。

> **免责声明**：本工具仅供个人学习研究使用，请遵守安居客、贝壳找房等平台的用户服务协议及相关法律法规。

---

## 环境要求

- Python 3.9+
- Google Chrome 或 Microsoft Edge（DrissionPage 自动匹配已安装版本）

## 安装与启动

```bash
cd scraper
pip install -r requirements.txt
python server.py
```

服务默认监听 `0.0.0.0:8765`。

---

## API 说明

### 健康检查

```
GET /health
```

### 安居客列表爬取

```
GET /api/scrape/anjuke?city=wh&page=1
```

- `city`：城市 code（如 `wh`）、城市名（如 `武汉`）或拼音（如 `wuhan`），与 App 内 `app/lib/cities.ts` 保持一致。
- `page`：页码，默认 1。

### 安居客关键词搜索（用于跨平台比价）

```
GET /api/search/anjuke?city=wh&q=光谷世界城&page=1
```

- URL 格式：`https://{code}.zu.anjuke.com/fangyuan/?q={关键词}`
- 武汉示例：`https://wh.zu.anjuke.com/fangyuan/?q=光谷世界城`
- 搜索结果使用与列表相同的 `.zu-itemmod` 卡片选择器，可直接解析。

### 贝壳列表爬取（半自动，需要 Cookie）

```
GET /api/scrape/beike?city=wh&page=1
```

首次使用前必须先完成 Cookie 初始化（见下方）。

### 贝壳关键词搜索（需要 Cookie，用于跨平台比价）

```
GET /api/search/beike?city=wh&q=光谷世界城&page=1
```

- URL 格式：`https://{code}.ke.com/zufang/rs{关键词}/`
- 武汉示例：`https://wh.ke.com/zufang/rs光谷世界城/`
- 分页：`https://wh.ke.com/zufang/rs光谷世界城/pg2/`
- 同样需要有效 Cookie，无 Cookie 时返回 `success: false`。

### 贝壳 Cookie 状态查询

```
GET /api/beike/cookie-status?city=wh
```

---

## 贝壳 Cookie 初始化（必做，仅一次）

**重要：必须在本机终端执行，不能用 HTTP 接口代替。**

```bash
cd scraper
python setup_beike.py wh
```

1. 会自动打开 Chrome，进入贝壳武汉租房列表
2. 在浏览器里完成登录 / 滑块验证，**确认页面出现租金数字（如 2500元/月）**
3. **回到运行上述命令的终端窗口**，按 **Enter**
4. 看到 `cookies/beike_wh.json` 生成且包含多条 Cookie 即成功

> 注意：App 里选择的城市必须与 setup 时指定的城市一致。
> 例如 App 选「武汉」→ 需先执行 `python setup_beike.py wh`；
> App 选「北京」→ 需先执行 `python setup_beike.py bj`。

检查 Cookie 是否有效：

```
GET /api/beike/cookie-status?city=wh
```

Cookie 保存在 `scraper/cookies/beike_{code}.json`，有效期内无需重复操作。失效时服务会返回明确错误提示。

---

## 真机调试（手机连接）

手机与电脑需处于同一 Wi-Fi 网络。在项目根目录创建或编辑 `.env` 文件：

```
EXPO_PUBLIC_SCRAPER_URL=http://<电脑局域网 IP>:8765
```

电脑局域网 IP 查询（Windows PowerShell）：

```powershell
(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' })[0].IPAddress
```

---

## 验证服务正常运行

```powershell
# 1. 健康检查
Invoke-RestMethod -Uri "http://127.0.0.1:8765/health"
# 期望输出：{ "service": "rentsmart-scraper", "status": "ok" }

# 2. 武汉安居客第 1 页
Invoke-RestMethod -Uri "http://127.0.0.1:8765/api/scrape/anjuke?city=wh&page=1"
# 期望：listings 数组非空，count >= 1

# 3. 安居客关键词搜索
Invoke-RestMethod -Uri "http://127.0.0.1:8765/api/search/anjuke?city=wh&q=光谷世界城"

# 4. 贝壳 Cookie 状态
Invoke-RestMethod -Uri "http://127.0.0.1:8765/api/beike/cookie-status?city=wh"

# 5. 贝壳列表（需先完成 Cookie 初始化）
Invoke-RestMethod -Uri "http://127.0.0.1:8765/api/scrape/beike?city=wh&page=1"
```

---

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SCRAPER_PORT` | `8765` | Flask 监听端口 |
| `SCRAPER_HEADLESS` | `0` | 设为 `1` 使安居客爬取以无头模式运行 |

---

## 目录说明

```
scraper/
  server.py           # Flask 主入口，路由与参数校验
  cities_loader.py    # 解析 ../app/lib/cities.ts，提供城市 code/name/pinyin 映射
  anjuke_scraper.py   # 安居客列表爬取 + 关键词搜索
  beike_scraper.py    # 贝壳半自动爬取 + Cookie 管理 + 关键词搜索
  setup_beike.py      # 贝壳 Cookie 初始化脚本（必须在终端运行）
  requirements.txt
  cookies/            # Cookie 文件（已加入 .gitignore，不提交）
```
