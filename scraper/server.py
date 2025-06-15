"""
RentSmart AI 爬虫 HTTP 服务
默认监听 0.0.0.0:8765，支持跨域（Expo 开发调试需要）。
"""

from flask import Flask, jsonify, request, Response
from flask_cors import CORS

from cities_loader import resolve_city
from anjuke_scraper import scrape_anjuke, scrape_anjuke_search
from beike_scraper import scrape_beike, scrape_beike_search, has_beike_cookie, _cookie_path

app = Flask(__name__)
CORS(app)  # 允许所有来源，生产环境按需收窄

# ── 工具 ──────────────────────────────────────────────────────
def _bad(reason: str, code: int = 400) -> tuple[Response, int]:
    return jsonify({'success': False, 'reason': reason, 'count': 0}), code


def _resolve_or_bad(city_param: str):
    """解析城市参数，失败直接返回 (None, error_response)。"""
    if not city_param:
        return None, _bad('缺少 city 参数（接受 code / 城市名 / 拼音，例如 wh / 武汉 / wuhan）')
    city = resolve_city(city_param)
    if not city:
        return None, _bad(f'未知城市：{city_param!r}，请参考 app/lib/cities.ts 中的 code/name/pinyin')
    return city, None


# ── 路由 ──────────────────────────────────────────────────────
@app.get('/health')
def health():
    from anjuke_scraper import SCRAPER_VERSION, anjuke_list_url
    return jsonify({
        'status': 'ok',
        'service': 'rentsmart-scraper',
        'version': SCRAPER_VERSION,
        'anjukeUrlExample': anjuke_list_url('wh', 1),
    })


@app.get('/api/scrape/anjuke')
def api_scrape_anjuke():
    city_param = request.args.get('city', '').strip()
    page = max(1, int(request.args.get('page', 1) or 1))

    city, err = _resolve_or_bad(city_param)
    if err:
        return err

    result = scrape_anjuke(city['code'], page)
    return jsonify(result)


@app.get('/api/scrape/beike')
def api_scrape_beike():
    city_param = request.args.get('city', '').strip()
    page = max(1, int(request.args.get('page', 1) or 1))

    city, err = _resolve_or_bad(city_param)
    if err:
        return err

    result = scrape_beike(city['code'], city['pinyin'], page)
    return jsonify(result)


@app.get('/api/beike/cookie-status')
def api_beike_cookie_status():
    """检查贝壳 Cookie 是否已保存。"""
    city_param = request.args.get('city', '').strip()
    city, err = _resolve_or_bad(city_param)
    if err:
        return err
    code = city['code']
    ok = has_beike_cookie(code)
    return jsonify({
        'city': code,
        'hasCookie': ok,
        'cookiePath': _cookie_path(code) if ok else None,
        'setupHint': f'cd scraper && python setup_beike.py {code}',
    })


@app.post('/api/beike/setup-cookie')
def api_beike_setup_cookie():
    """
    贝壳登录必须在终端交互完成，HTTP 无法代替按 Enter。
    请使用独立脚本：python setup_beike.py wh
    """
    city_param = (request.get_json(silent=True) or {}).get('city') or request.args.get('city', '')
    city_param = str(city_param).strip()
    city, err = _resolve_or_bad(city_param)
    if err:
        return err
    code = city['code']
    return jsonify({
        'success': False,
        'reason': (
            '贝壳 Cookie 必须在本机终端完成，HTTP 接口无法代替。\n'
            f'请执行：cd scraper && python setup_beike.py {code}\n'
            '按提示在浏览器完成验证，回到终端按 Enter 即可。'
        ),
        'command': f'python setup_beike.py {code}',
    }), 400


@app.post('/api/beike/update-cookie')
def api_beike_update_cookie():
    """手机端更新贝壳 Cookie（直接保存用户提供的 Cookie 字符串）。"""
    data = request.get_json(silent=True) or {}
    city_param = str(data.get('city', '')).strip()
    cookie_str = str(data.get('cookie', '')).strip()
    
    if not cookie_str:
        return jsonify({'success': False, 'message': '缺少 cookie 参数'}), 400
    
    city, err = _resolve_or_bad(city_param)
    if err:
        return err
    
    code = city['code']
    
    try:
        # 保存 Cookie 到文件
        import os
        cookie_file = _cookie_path(code)
        os.makedirs(os.path.dirname(cookie_file), exist_ok=True)
        
        with open(cookie_file, 'w', encoding='utf-8') as f:
            f.write(cookie_str)
        
        return jsonify({
            'success': True,
            'message': f'贝壳 Cookie 已保存到 {cookie_file}',
            'city': code,
        })
    except Exception as e:
        return jsonify({
            'success': False,
            'message': f'保存失败：{str(e)}',
        }), 500


@app.get('/api/search/anjuke')
def api_search_anjuke():
    """关键词搜索安居客（用于跨平台比价）。"""
    city_param = request.args.get('city', '').strip()
    query = request.args.get('q', '').strip()
    page = max(1, int(request.args.get('page', 1) or 1))

    if not query:
        return _bad('缺少 q 参数（搜索关键词，如 光谷世界城 两居室）')

    city, err = _resolve_or_bad(city_param)
    if err:
        return err

    result = scrape_anjuke_search(city['code'], query, page)
    return jsonify(result)


@app.get('/api/search/beike')
def api_search_beike():
    """关键词搜索贝壳（需要 Cookie，用于跨平台比价）。"""
    city_param = request.args.get('city', '').strip()
    query = request.args.get('q', '').strip()
    page = max(1, int(request.args.get('page', 1) or 1))

    if not query:
        return _bad('缺少 q 参数（搜索关键词，如 光谷世界城 两居室）')

    city, err = _resolve_or_bad(city_param)
    if err:
        return err

    result = scrape_beike_search(city['code'], query, page)
    return jsonify(result)


# ── 入口 ──────────────────────────────────────────────────────
if __name__ == '__main__':
    port = int(__import__('os').environ.get('SCRAPER_PORT', 8765))
    print(f'[RentSmart Scraper] 监听 0.0.0.0:{port}')
    print('[RentSmart Scraper] 安居客列表：   GET /api/scrape/anjuke?city=wh&page=1')
    print('[RentSmart Scraper] 安居客搜索：   GET /api/search/anjuke?city=wh&q=光谷世界城')
    print('[RentSmart Scraper] 贝壳列表：     GET /api/scrape/beike?city=wh&page=1')
    print('[RentSmart Scraper] 贝壳搜索：     GET /api/search/beike?city=wh&q=光谷世界城')
    print('[RentSmart Scraper] 贝壳 Cookie：  cd scraper && python setup_beike.py wh')
    app.run(host='0.0.0.0', port=port, threaded=True)
