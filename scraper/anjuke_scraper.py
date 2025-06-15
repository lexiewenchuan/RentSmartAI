"""
安居客租房列表爬取（DrissionPage）。

经调试确认的正确信息：
  - 页面 URL：https://{city_code}.zu.anjuke.com/            （第1页）
              https://{city_code}.zu.anjuke.com/fangyuan/p{N}/（第N页，N>=2）
  - 卡片选择器：.zu-itemmod（motion 元素，每页约60个）
  - 详情链接：div.zu-itemmod 的 link 属性（非 href）
  - 标题：h3
  - 价格：.price（纯数字，单位元/月）
  - 户型/面积/楼层：.details-item（格式：3室1厅|25平米|第5层）

注意：URL 使用城市 code（如 wh），不是拼音（wuhan）。
"""

import re
import time
import os
import threading
from typing import Optional

from DrissionPage import ChromiumPage, ChromiumOptions

HEADLESS = os.environ.get('SCRAPER_HEADLESS', '0') == '1'
_SCRAPE_LOCK = threading.Lock()
SCRAPER_VERSION = '2.1.0-zu'


# ── URL 构建 ──────────────────────────────────────────────────
def anjuke_list_url(code: str, page: int = 1) -> str:
    base = f"https://{code}.zu.anjuke.com/"
    if page <= 1:
        return base
    return f"{base}fangyuan/p{page}/"


def anjuke_search_url(code: str, query: str, page: int = 1) -> str:
    """关键词搜索 URL（小区名、商圈、户型等）。
    URL 格式：https://{code}.zu.anjuke.com/fangyuan/?q={query}
    分页：https://{code}.zu.anjuke.com/fangyuan/p{page}/?q={query}
    """
    from urllib.parse import quote
    q = quote(query.strip(), safe='')
    base = f"https://{code}.zu.anjuke.com/"
    if page <= 1:
        return f"{base}fangyuan/?q={q}"
    return f"{base}fangyuan/p{page}/?q={q}"


# ── 风控检测 ──────────────────────────────────────────────────
_BLOCK_RE = re.compile(r'验证|人机|滑块|安全验证|请登录|访问受限|blocked|captcha', re.IGNORECASE)

def _is_blocked(page: ChromiumPage) -> bool:
    title = page.title or ''
    try:
        body_text = (page.ele('css:body').text or '')[:500]
    except Exception:
        body_text = ''
    return bool(_BLOCK_RE.search(title + body_text))


# ── 字段解析辅助 ──────────────────────────────────────────────
_PRICE_RE = re.compile(r'(\d{3,6})')
_ROOM_RE  = re.compile(r'(\d室\d厅|\d室|合租|整租|主卧|次卧|一居|两居|三居|四居)')
_AREA_RE  = re.compile(r'(\d+(?:\.\d+)?\s*(?:㎡|平米?|平方米))')
_FLOOR_RE = re.compile(r'(第\d+层|[高低中]楼层(?:[/共]\d+层)?|\d+/\d+层|\d+层)')
_COMM_RE  = re.compile(r'([\u4e00-\u9fa5]{2,20}(?:小区|花园|公寓|里|苑|家园|新村|大厦|中心|广场|城|庭|园|邸|府|轩|居|坊|阁|湾|庄))')
_DIST_RE  = re.compile(r'([\u4e00-\u9fa5]{2,10}(?:区|县|镇|街道))')


def _text(el, css: str) -> str:
    try:
        sub = el.ele(f'css:{css}', timeout=0)
        return (sub.text or '').strip() if sub else ''
    except Exception:
        return ''


def _parse_details(detail_text: str) -> tuple[str, str, str]:
    parts = [p.strip() for p in detail_text.split('|')]
    roomType, area, floor = '', '', ''
    for p in parts:
        if not roomType and _ROOM_RE.search(p):
            roomType = p
        if not area and _AREA_RE.search(p):
            area = p
        if not floor and _FLOOR_RE.search(p):
            floor = p
    if not roomType:
        m = _ROOM_RE.search(detail_text)
        if m:
            roomType = m.group(1)
    if not area:
        m = _AREA_RE.search(detail_text)
        if m:
            area = m.group(1)
    if not floor:
        m = _FLOOR_RE.search(detail_text)
        if m:
            floor = m.group(1)
    return roomType, area, floor


def _parse_location(text: str) -> tuple[str, str]:
    community, district = '', ''
    m = _COMM_RE.search(text)
    if m:
        community = m.group(1)
    m = _DIST_RE.search(text)
    if m:
        district = m.group(1)
    if not community:
        loc_m = re.search(
            r'([\u4e00-\u9fa5]{2,10})-[\u4e00-\u9fa5\s]+-?([\u4e00-\u9fa5]{2,15}(?:路|街|巷|道|弄|里|桥|湖|园|村))',
            text,
        )
        if loc_m:
            community = loc_m.group(2)
            if not district:
                district = loc_m.group(1)
    return community, district


def _fix_img(src: str) -> str:
    if not src:
        return ''
    if src.startswith('http'):
        return src
    if src.startswith('//'):
        return 'https:' + src
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
    has_community = len(listing.get('community', '') or '') >= 2
    has_district = len(listing.get('district', '') or '') >= 2
    return has_community or has_district


def _parse_card(card, base_url: str) -> Optional[dict]:
    try:
        url = (card.attr('link') or '').strip()
        if not url:
            try:
                a = card.ele('css:a[href*="fangyuan"]', timeout=0)
                url = (a.attr('href') or '') if a else ''
            except Exception:
                pass
        if not url or 'fangyuan' not in url:
            return None

        url_clean = url.split('?')[0]
        full_text = (card.text or '').replace('\n', ' ').strip()
        if len(full_text) < 20:
            return None

        title = _text(card, 'h3') or _text(card, '[class*="title"]')
        title = re.sub(r'\s{2,}', ' ', title).strip()
        if not title or len(title) < 4:
            return None

        price_str = _text(card, '.price') or _text(card, '[class*="price"]')
        price = 0
        m = _PRICE_RE.search(price_str)
        if m:
            price = int(m.group(1))
        if not price:
            fm = re.search(r'(\d{3,6})\s*(?:元/月|元每月)', full_text)
            if fm:
                price = int(fm.group(1))
        if not price or price < 300 or price > 50000:
            return None

        detail_text = _text(card, '.details-item')
        roomType, area, floor = _parse_details(detail_text or full_text)
        community, district = _parse_location(full_text)
        if not community and not district:
            return None

        tags: list[str] = []
        try:
            for el in card.eles('css:.tag, [class*="tag-"], .item-condition span', timeout=0):
                t = (el.text or '').strip()
                if 2 <= len(t) <= 10 and not re.match(r'^[\d\.]+$', t):
                    tags.append(t)
            tags = list(dict.fromkeys(tags))[:6]
        except Exception:
            pass

        image_url = ''
        try:
            img = card.ele('css:img', timeout=0)
            if img:
                src = img.attr('src') or img.attr('data-src') or img.attr('data-original') or ''
                image_url = _fix_img(src)
        except Exception:
            pass

        result = {
            'title': title,
            'price': price,
            'community': community or '未知小区',
            'district': district or '未知区域',
            'roomType': roomType or '未知',
            'area': area or '未知',
            'floor': floor or '',
            'tags': tags,
            'url': url,
            'imageUrl': image_url,
            'platform': 'anjuke',
            '_dedup': url_clean,
        }
        print(f"[DEBUG] 房源URL: {url if url else '空'}")
        return result
    except Exception:
        return None


# ── ChromiumPage 单例 ─────────────────────────────────────────
_dp_instance: Optional[ChromiumPage] = None


def _reset_page() -> None:
    global _dp_instance
    if _dp_instance is not None:
        try:
            _dp_instance.quit()
        except Exception:
            pass
        _dp_instance = None


def _get_page() -> ChromiumPage:
    global _dp_instance
    if _dp_instance is None:
        opts = ChromiumOptions()
        if HEADLESS:
            opts.headless()
        opts.set_argument('--disable-blink-features=AutomationControlled')
        opts.set_argument('--no-sandbox')
        opts.set_argument('--disable-gpu')
        _dp_instance = ChromiumPage(addr_or_opts=opts)
    return _dp_instance


def _is_correct_zu_url(current: str, code: str) -> bool:
    return bool(current) and f'{code}.zu.anjuke.com' in current


def _wait_for_cards(dp: ChromiumPage, timeout: float = 20) -> list:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            cards = dp.eles('css:.zu-itemmod', timeout=2)
            if cards:
                return cards
        except Exception:
            pass
        time.sleep(1)
    try:
        return [el for el in dp.eles('css:motion:motion:motion:div[link*="fangyuan"]', timeout=1)]
    except Exception:
        pass
    try:
        return [el for el in dp.eles('css:motion:div[link*="fangyuan"]', timeout=1)]
    except Exception:
        return []


def _scrape_once(code: str, page: int) -> dict:
    url = anjuke_list_url(code, page)
    dp = _get_page()
    dp.get(url)
    time.sleep(5)

    current_url = dp.url or url
    title = dp.title or ''

    if not _is_correct_zu_url(current_url, code):
        return {
            'type': 'scrape_result',
            'success': False,
            'reason': (
                f'页面地址错误（当前：{current_url}）。'
                f'请重启爬虫服务后重试，正确地址：https://{code}.zu.anjuke.com/'
            ),
            'count': 0,
            'debug': {
                'url': current_url,
                'expectedUrl': url,
                'title': title,
                'foundCards': 0,
                'scraperVersion': SCRAPER_VERSION,
            },
        }

    if _is_blocked(dp):
        return {
            'type': 'scrape_result',
            'success': False,
            'reason': f'触发风控或需要验证（{title}），请在浏览器中完成验证后重试',
            'count': 0,
            'debug': {'url': current_url, 'title': title},
        }

    cards = _wait_for_cards(dp, timeout=20)
    if not cards:
        return {
            'type': 'scrape_result',
            'success': False,
            'reason': '未找到房源卡片（列表未加载完成，请稍后重试）',
            'count': 0,
            'debug': {
                'url': current_url,
                'expectedUrl': url,
                'title': title,
                'foundCards': 0,
                'scraperVersion': SCRAPER_VERSION,
            },
        }

    listings = []
    seen: set[str] = set()
    for card in cards:
        item = _parse_card(card, current_url)
        if item and _is_valid(item):
            dedup = item.pop('_dedup', item['url'].split('?')[0])
            if dedup not in seen:
                seen.add(dedup)
                listings.append(item)

    return {
        'type': 'scrape_result',
        'success': True,
        'platform': 'anjuke',
        'page': page,
        'count': len(listings),
        'listings': listings,
        'debug': {
            'url': current_url,
            'title': title,
            'foundCards': len(cards),
            'validListings': len(listings),
            'scraperVersion': SCRAPER_VERSION,
        },
    }


def scrape_anjuke(code: str, page: int = 1) -> dict:
    with _SCRAPE_LOCK:
        try:
            result = _scrape_once(code, page)
            if not result.get('success') and '地址错误' in (result.get('reason') or ''):
                _reset_page()
                result = _scrape_once(code, page)
            return result
        except Exception as e:
            _reset_page()
            return {
                'type': 'scrape_result',
                'success': False,
                'reason': f'抓取异常：{e}',
                'count': 0,
                'debug': {'url': anjuke_list_url(code, page), 'scraperVersion': SCRAPER_VERSION},
            }


def scrape_anjuke_search(code: str, query: str, page: int = 1) -> dict:
    """按关键词搜索安居客租房列表（用于跨平台比价）。"""
    with _SCRAPE_LOCK:
        try:
            url = anjuke_search_url(code, query, page)
            dp = _get_page()
            dp.get(url)
            time.sleep(5)

            current_url = dp.url or url
            title = dp.title or ''

            if _is_blocked(dp):
                return {
                    'type': 'scrape_result',
                    'success': False,
                    'reason': f'触发风控（{title}），请稍后重试',
                    'count': 0,
                }

            cards = _wait_for_cards(dp, timeout=20)
            if not cards:
                return {
                    'type': 'scrape_result',
                    'success': True,
                    'platform': 'anjuke',
                    'page': page,
                    'count': 0,
                    'listings': [],
                    'query': query,
                }

            listings = []
            seen: set[str] = set()
            for card in cards:
                item = _parse_card(card, current_url)
                if item and _is_valid(item):
                    dedup = item.pop('_dedup', item['url'].split('?')[0])
                    if dedup not in seen:
                        seen.add(dedup)
                        listings.append(item)

            return {
                'type': 'scrape_result',
                'success': True,
                'platform': 'anjuke',
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
