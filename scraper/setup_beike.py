"""
贝壳 Cookie 初始化（独立脚本，推荐用法）。

用法：
  cd scraper
  python setup_beike.py wh

会在本机打开浏览器，请完成登录/滑块验证后，回到此终端按 Enter。
Cookie 保存到 cookies/beike_{code}.json
"""

import sys
import os

# 确保能 import 同目录模块
sys.path.insert(0, os.path.dirname(__file__))

from cities_loader import resolve_city
from beike_scraper import setup_beike_cookie


def main():
    if len(sys.argv) < 2:
        print('用法: python setup_beike.py <城市code>')
        print('示例: python setup_beike.py wh')
        sys.exit(1)

    query = sys.argv[1].strip()
    city = resolve_city(query)
    if not city:
        print(f'未知城市: {query!r}')
        sys.exit(1)

    print(f'城市: {city["name"]} (code={city["code"]})')
    result = setup_beike_cookie(city['code'], city['pinyin'])

    if result.get('success'):
        print(f'\n成功: {result.get("message")}')
        print(f'文件: {result.get("cookiePath")}')
    else:
        print(f'\n失败: {result.get("reason")}')
        sys.exit(1)


if __name__ == '__main__':
    main()
