"""
解析 ../app/lib/cities.ts，提供城市 code / name / pinyin 三元组的查询能力。
与 App 共用同一份数据源，无需手动维护双份映射。
"""

import re
import os
from typing import Optional

# cities.ts 相对于本文件的路径
_CITIES_TS_PATH = os.path.join(os.path.dirname(__file__), '..', 'app', 'lib', 'cities.ts')

# 解析后的城市列表，延迟初始化
_cities: list[dict] = []


def _load_cities() -> list[dict]:
    """从 cities.ts 中用正则提取城市三元组列表。"""
    with open(_CITIES_TS_PATH, encoding='utf-8') as f:
        content = f.read()

    # 匹配每个城市对象，例如：{ code: 'wh', name: '武汉', pinyin: 'wuhan', hot: true }
    pattern = re.compile(
        r'\{\s*code:\s*[\'"]([^\'"]+)[\'"]\s*,\s*name:\s*[\'"]([^\'"]+)[\'"]\s*,\s*pinyin:\s*[\'"]([^\'"]+)[\'"]',
        re.DOTALL,
    )
    cities = []
    for m in pattern.finditer(content):
        cities.append({'code': m.group(1), 'name': m.group(2), 'pinyin': m.group(3)})
    return cities


def get_cities() -> list[dict]:
    """返回所有城市（延迟加载）。"""
    global _cities
    if not _cities:
        _cities = _load_cities()
    return _cities


def resolve_city(query: str) -> Optional[dict]:
    """
    接受 code（如 wh）、城市名（如 武汉）或拼音（如 wuhan），
    返回 {'code': ..., 'name': ..., 'pinyin': ...}，找不到返回 None。
    """
    q = query.strip().lower()
    for city in get_cities():
        if city['code'].lower() == q or city['name'] == query.strip() or city['pinyin'].lower() == q:
            return city
    return None


if __name__ == '__main__':
    # 简单自测
    for test in ['wh', '武汉', 'wuhan', 'bj', '北京', 'beijing', 'xxx']:
        result = resolve_city(test)
        print(f'{test!r:12} -> {result}')
