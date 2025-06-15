"""
贝壳租房爬取（DrissionPage）—— 半自动方案。

推荐初始化方式（不要用 App 触发 POST，容易漏按 Enter）：
  cd scraper
  python setup_beike.py wh
"""

import json
import os
import re
import time
import threading
from typing import Optional

from DrissionPage import ChromiumPage, ChromiumOptions

_COOKIE_DIR = os.path.join(os.path.dirname(__file__), 'cookies')
_SCRAPE_LOCK = threading.Lock()

# 贝壳城市子域：多数城市用 code，少数需 fallback
_BEIKE_URL_FALLBACKS = [
    lambda code, page: f'https://{code}.ke.com/zufang/' if page <= 1 else f'https://{code}.ke.com/zufang/pg{page}/',
    lambda code, page: f'https://ke.com/chuzu/{code}/' if page <= 1 else f'https://ke.com/chuzu/{code}/pg{page}/',
]


def _beike_list_url(code: str, page: int = 1) -> str:
    return _BEIKE_URL_FALLBACKS[0](code, page)


def beike_search_url(code: str, query: str, page: int = 1) -> str:
    """关键词搜索 URL（rs{query} 是贝壳/链家的搜索路径格式）。
    示例：https://wh.ke.com/zufang/rs光谷世界城/
    分页：https://wh.ke.com/zufang/rs光谷世界城/pg2/
    """
    from urllib.parse import quote
    q = quote(query.strip(), safe='')
    if page <= 1:
        return f'https://{code}.ke.com/zufang/rs{q}/'
    return f'https://{code}.ke.com/zufang/rs{q}/pg{page}/'


def _cookie_path(code: str) -> str:
    return os.path.join(_COOKIE_DIR, f'beike_{code}.json')


_BLOCK_RE = re.compile(r'验证|人机|滑块|安全验证|请登录|访问受限|blocked|captcha', re.IGNORECASE)

def _is_blocked(page: ChromiumPage) -> bool:
    title = page.title or ''
    try:
        body_text = (page.ele('css:body').text or '')[:800]
    except Exception:
        body_text = ''
    sample = title + body_text
    if _BLOCK_RE.search(sample):
        return True
    # 列表页应有租金特征
    if '元/月' not in sample and '租房' in sample and '登录' in sample:
        return True
    return False


def _text(el, css: str) -> str:
    try:
        sub = el.ele(f'css:{css}', timeout=0)
        return (sub.text or '').strip() if sub else ''
    except Exception:
        return ''


def _eles_text(el, css: str) -> list[str]:
    try:
        items = el.eles(f'css:{css}', timeout=0)
        return [(e.text or '').strip() for e in items if (e.text or '').strip()]
    except Exception:
        return []


_PRICE_RE = re.compile(r'(\d{3,6})')
_ROOM_RE = re.compile(r'(\d室\d厅|\d室|合租|整租|主卧|次卧|一居|两居|三居|四居)')
_AREA_RE = re.compile(r'(\d+(?:\.\d+)?\s*(?:㎡|平米?|平方米))')
_FLOOR_RE = re.compile(r'([高低中]楼层(?:[/共]\d+层)?|\d+/\d+层|\d+层)')
_COMMUNITY_RE = re.compile(r'([\u4e00-\u9fa5]{2,20}(?:小区|花园|公寓|里|苑|家园|新村|大厦|中心|广场|城|庭|园|邸|府|轩|居|坊|阁|湾|庄))')
_DISTRICT_RE = re.compile(r'([\u4e00-\u9fa5]{2,10}(?:区|县|镇|街道))')


def _parse_price(text: str) -> int:
    m = _PRICE_RE.search(text)
    if m:
        v = int(m.group(1))
        if 300 <= v <= 50000:
            return v
    return 0


def _parse_location(text: str) -> tuple[str, str]:
    c = _COMMUNITY_RE.search(text)
    d = _DISTRICT_RE.search(text)
    return (c.group(1) if c else ''), (d.group(1) if d else '')


def _fix_img_url(src: str, base_url: str) -> str:
    if not src:
        return ''
    if src.startswith('http'):
        return src
    if src.startswith('//'):
        return 'https:' + src
    if src.startswith('/'):
        m = re.match(r'(https?://[^/]+)', base_url)
        return (m.group(1) if m else '') + src
    return ''


def _is_valid(listing: dict) -> bool:
    url = listing.get('url', '')
    if not url or len(url) < 10:
        return False
    price = listing.get('price', 0)
    if not price or price < 300 or price > 50000:
        return False
    title = (listing.get('title') or '').strip()
    if len(title) < 4 or re.match(r'^[\d\s元月]+$', title):
        return False
    has_comm = len(listing.get('community', '') or '') >= 2
    has_dist = len(listing.get('district', '') or '') >= 2
    return has_comm or has_dist


def _parse_card(card, page_url: str) -> Optional[dict]:
    try:
        full_text = (card.text or '').replace('\n', ' ').strip()
        if len(full_text) < 30:
            return None

        anchor = None
        for sel in ['a[href*="ke.com"]', 'a[href*="zufang"]', 'a[href*="chuzu"]', 'a']:
            try:
                anchor = card.ele(f'css:{sel}', timeout=0)
                if anchor:
                    break
            except Exception:
                continue
        if not anchor:
            return None
        href = anchor.attr('href') or ''
        if not href:
            return None
        if href.startswith('http'):
            url = href
        elif href.startswith('//'):
            url = 'https:' + href
        elif href.startswith('/'):
            m = re.match(r'(https?://[^/]+)', page_url)
            url = (m.group(1) if m else 'https://ke.com') + href
        else:
            url = href
        if not any(k in url for k in ['ke.com', '/zufang/', '/chuzu/']):
            return None

        title = ''
        for sel in ['.content__list--item--title', '.house-title', '.title', 'h3', 'h2',
                    '[class*="title"]']:
            t = _text(card, sel)
            if t and len(t) > 6:
                title = t
                break
        if not title:
            title = (anchor.text or '').strip()
        title = re.sub(r'\s{2,}', ' ', title).strip()
        if not title or len(title) < 4:
            return None

        price = 0
        for sel in ['.content__list--item-price', '.price-num', '.price', '[class*="price"]']:
            t = _text(card, sel)
            if t:
                price = _parse_price(t)
                if price:
                    break
        if not price:
            price = _parse_price(full_text)
        if not price:
            return None

        info_text = full_text
        for sel in ['.content__list--item--des', '.info', '[class*="desc"]']:
            t = _text(card, sel)
            if t:
                info_text = t
                break
        room_m = _ROOM_RE.search(info_text)
        area_m = _AREA_RE.search(info_text)
        floor_m = _FLOOR_RE.search(info_text)

        community, district = '', ''
        for sel in ['.content__list--item--des', '.address', '[class*="community"]']:
            t = _text(card, sel)
            if t:
                c, d = _parse_location(t)
                community = community or c
                district = district or d
        if not community and not district:
            c, d = _parse_location(full_text)
            community, district = c, d
        if not community and not district:
            return None

        tags: list[str] = []
        for sel in ['.tag', 'span.tag', '[class*="tag-"]']:
            for t in _eles_text(card, sel):
                if 2 <= len(t) <= 8:
                    tags.append(t)
        tags = list(dict.fromkeys(tags))[:6]

        image_url = ''
        try:
            img = card.ele('css:img', timeout=0)
            if img:
                src = img.attr('src') or img.attr('data-src') or ''
                image_url = _fix_img_url(src, page_url)
        except Exception:
            pass

        return {
            'title': title,
            'price': price,
            'community': community or '未知小区',
            'district': district or '未知区域',
            'roomType': room_m.group(1) if room_m else '未知',
            'area': area_m.group(1) if area_m else '未知',
            'floor': floor_m.group(1) if floor_m else '',
            'tags': tags,
            'url': url,
            'imageUrl': image_url,
            'platform': 'beike',
        }
    except Exception:
        return None


def _save_cookies(page: ChromiumPage, code: str) -> str:
    os.makedirs(_COOKIE_DIR, exist_ok=True)
    path = _cookie_path(code)
    cookies = page.cookies(all_domains=True)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(cookies, f, ensure_ascii=False, indent=2)
    return path


def _load_cookies(page: ChromiumPage, code: str) -> tuple[bool, str]:
    """加载 Cookie 并注入浏览器。返回 (成功, 失败原因)。"""
    path = _cookie_path(code)
    if not os.path.exists(path):
        return False, f'Cookie 文件不存在：{path}'
    try:
        with open(path, encoding='utf-8') as f:
            cookies = json.load(f)
    except json.JSONDecodeError as e:
        return False, f'Cookie 文件格式错误：{e}'
    except OSError as e:
        return False, f'Cookie 文件读取失败：{e}'

    if not cookies or not isinstance(cookies, list):
        return False, 'Cookie 文件为空或格式不正确'

    # 先访问贝壳主域再注入，确保 Cookie 域匹配
    try:
        page.get(f'https://{code}.ke.com/')
        time.sleep(1)
        page.set.cookies(cookies)
        return True, ''
    except Exception as e:
        return False, f'Cookie 注入异常：{e}'


def has_beike_cookie(code: str) -> bool:
    """检查贝壳 Cookie 文件是否存在且包含有效 Cookie 条目。"""
    path = _cookie_path(code)
    if not os.path.exists(path):
        return False
    try:
        if os.path.getsize(path) <= 10:
            return False
        with open(path, encoding='utf-8') as f:
            data = json.load(f)
        return isinstance(data, list) and len(data) > 0
    except Exception:
        return False


_page_instance: Optional[ChromiumPage] = None


def _reset_page() -> None:
    global _page_instance
    if _page_instance is not None:
        try:
            _page_instance.quit()
        except Exception:
            pass
        _page_instance = None


def _get_page(headless: bool = False) -> ChromiumPage:
    global _page_instance
    if _page_instance is None:
        opts = ChromiumOptions()
        if headless:
            opts.headless()
        opts.set_argument('--disable-blink-features=AutomationControlled')
        opts.set_argument('--no-sandbox')
        _page_instance = ChromiumPage(addr_or_opts=opts)
    return _page_instance


def _wait_for_beike_cards(dp: ChromiumPage, timeout: float = 20) -> list:
    deadline = time.time() + timeout
    selectors = [
        '.content__list--item',
        'div[data-house_code]',
    ]
    while time.time() < deadline:
        for sel in selectors:
            try:
                cards = dp.eles(f'css:{sel}', timeout=2)
                if cards:
                    return cards
            except Exception:
                pass
        time.sleep(1)
    return []


def setup_beike_cookie(code: str, pinyin: str) -> dict:
    """有头浏览器登录并保存 Cookie。"""
    url = _beike_list_url(code, 1)
    page = _get_page(headless=False)
    try:
        page.get(url)
        print('\n' + '=' * 60)
        print('[贝壳 Cookie 初始化]')
        print(f'已在浏览器打开：{url}')
        print('请完成登录/滑块验证，确认能看到租房列表（页面出现租金数字）后，')
        print('回到【本窗口】按 Enter 保存 Cookie...')
        print('=' * 60)
        input()

        # 按 Enter 前校验页面是否真正可见列表
        current_title = page.title or ''
        if _is_blocked(page):
            return {
                'success': False,
                'reason': (
                    f'当前页面疑似仍在验证中（标题：{current_title}）。\n'
                    '请先在浏览器完成滑块/登录，确认能看到租房列表再按 Enter。'
                ),
            }

        path = _save_cookies(page, code)
        size = os.path.getsize(path)
        if size < 50:
            return {
                'success': False,
                'reason': f'Cookie 文件过小（{size} 字节），可能未登录成功，请重试',
            }

        # 验证保存的 Cookie 有内容
        try:
            with open(path, encoding='utf-8') as f:
                saved = json.load(f)
            if not isinstance(saved, list) or len(saved) == 0:
                return {'success': False, 'reason': 'Cookie 已写入但内容为空，请重试'}
        except Exception as e:
            return {'success': False, 'reason': f'Cookie 写入验证失败：{e}'}

        return {
            'success': True,
            'message': f'Cookie 已保存（{code}），共 {size} 字节，{len(saved)} 条',
            'cookiePath': path,
        }
    except Exception as e:
        return {'success': False, 'reason': f'Cookie 初始化失败：{e}'}


def _scrape_once(code: str, page: int) -> dict:
    if not has_beike_cookie(code):
        return {
            'type': 'scrape_result',
            'success': False,
            'reason': (
                f'贝壳（{code}）尚未登录。\n'
                '请在电脑终端执行：\n'
                f'  cd scraper\n'
                f'  python setup_beike.py {code}\n'
                '按提示在浏览器完成验证后，回到终端按 Enter。'
            ),
            'count': 0,
        }

    url = _beike_list_url(code, page)
    # 贝壳反爬强，优先有头 + Cookie（比无头更稳）
    dp = _get_page(headless=False)
    ok, load_err = _load_cookies(dp, code)
    if not ok:
        return {
            'type': 'scrape_result',
            'success': False,
            'reason': f'Cookie 加载失败（{load_err}），请重新执行: python setup_beike.py {code}',
            'count': 0,
        }

    dp.get(url)
    time.sleep(6)

    current_url = dp.url or url
    title = dp.title or ''

    if _is_blocked(dp):
        return {
            'type': 'scrape_result',
            'success': False,
            'reason': f'Cookie 已失效（{title}），请重新执行: python setup_beike.py {code}',
            'count': 0,
            'debug': {'url': current_url, 'title': title},
        }

    cards = _wait_for_beike_cards(dp)
    if not cards:
        return {
            'type': 'scrape_result',
            'success': False,
            'reason': '未找到房源卡片（Cookie 可能失效或页面结构变化）',
            'count': 0,
            'debug': {'url': current_url, 'title': title, 'foundCards': 0},
        }

    listings = []
    seen: set[str] = set()
    for card in cards:
        item = _parse_card(card, current_url)
        if item and _is_valid(item):
            key = item['url'].split('?')[0]
            if key not in seen:
                seen.add(key)
                listings.append(item)

    return {
        'type': 'scrape_result',
        'success': True,
        'platform': 'beike',
        'page': page,
        'count': len(listings),
        'listings': listings,
        'debug': {
            'url': current_url,
            'title': title,
            'foundCards': len(cards),
            'validListings': len(listings),
        },
    }


def scrape_beike(code: str, pinyin: str, page: int = 1) -> dict:
    with _SCRAPE_LOCK:
        try:
            return _scrape_once(code, page)
        except Exception as e:
            _reset_page()
            return {
                'type': 'scrape_result',
                'success': False,
                'reason': f'抓取异常：{e}',
                'count': 0,
            }


def scrape_beike_search(code: str, query: str, page: int = 1) -> dict:
    """按关键词搜索贝壳租房列表（用于跨平台比价，需要 Cookie）。"""
    with _SCRAPE_LOCK:
        try:
            if not has_beike_cookie(code):
                return {
                    'type': 'scrape_result',
                    'success': False,
                    'reason': (
                        f'贝壳（{code}）尚未登录，无法搜索。\n'
                        f'请执行：cd scraper && python setup_beike.py {code}'
                    ),
                    'count': 0,
                }

            url = beike_search_url(code, query, page)
            dp = _get_page(headless=False)
            ok, load_err = _load_cookies(dp, code)
            if not ok:
                return {
                    'type': 'scrape_result',
                    'success': False,
                    'reason': f'Cookie 加载失败（{load_err}），请重新执行: python setup_beike.py {code}',
                    'count': 0,
                }

            dp.get(url)
            time.sleep(6)

            if _is_blocked(dp):
                return {
                    'type': 'scrape_result',
                    'success': False,
                    'reason': f'Cookie 已失效，请重新执行: python setup_beike.py {code}',
                    'count': 0,
                }

            cards = _wait_for_beike_cards(dp)
            if not cards:
                return {
                    'type': 'scrape_result',
                    'success': True,
                    'platform': 'beike',
                    'page': page,
                    'count': 0,
                    'listings': [],
                    'query': query,
                }

            listings = []
            seen: set[str] = set()
            current_url = dp.url or url
            for card in cards:
                item = _parse_card(card, current_url)
                if item and _is_valid(item):
                    key = item['url'].split('?')[0]
                    if key not in seen:
                        seen.add(key)
                        listings.append(item)

            return {
                'type': 'scrape_result',
                'success': True,
                'platform': 'beike',
                'page': page,
                'count': len(listings),
                'listings': listings,
                'query': query,
            }
        except Exception as e:
            _reset_page()
            return {
                'type': 'scrape_result',
                'success': False,
                'reason': f'搜索异常：{e}',
                'count': 0,
            }
