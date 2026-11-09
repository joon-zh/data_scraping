# -*- coding: utf-8 -*-
"""Lazada 店铺解析与商品/评价抓取。

平台说明：
- Lazada（阿里 TMD 风控）对自动化请求返回 _____tmd_____/punish 滑块验证页，需先由操作者在
  弹出的浏览器窗口中人工完成一次滑块验证（api.py /api/v1/lazada/verify），验证 Cookie 落盘
  lazada_cookies.json 后续复用。
- 页面为 React 渲染，数据在 window.pageData JSON 中；商品列表走店铺页 ?ajax=true 分页 JSON。
- 评价在商品详情页（PDP）评论区公开可见（含各国买家），通过浏览器加载详情页提取。

用法（经 api.py 调用）：
  resolve_store(platform='lazada', url='https://www.lazada.com.my/shop/<slug>/...')
  resolve_product(platform='lazada', identifier='<itemId 或商品链接>', detail=True)
"""

import json
import re
import time
from urllib.parse import urlparse, parse_qs

# Lazada 站点域名后缀 → ISO 3166-1 alpha-2 国家码
LAZADA_TLD_COUNTRY = {
    'com.my': 'MY', 'co.th': 'TH', 'com.ph': 'PH', 'sg': 'SG',
    'id': 'ID', 'vn': 'VN', 'com': 'US',
}

LAZADA_COOKIE_FILE = 'lazada_cookies.json'


class LazadaError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def parse_store_url(url):
    """Lazada 店铺/商品链接 → 定位模型（shop slug、itemId、站点国家）。"""
    u = urlparse(url)
    if u.scheme not in ('http', 'https') or 'lazada.' not in u.netloc:
        raise LazadaError('VALIDATION_ERROR', f'不是有效的 Lazada 链接：{url}')
    host = u.netloc.lower()
    country = None
    for tld, c in LAZADA_TLD_COUNTRY.items():
        if host == f'www.lazada.{tld}' or host.endswith(f'lazada.{tld}'):
            country = c
            break
    if not country:
        raise LazadaError('COUNTRY_NOT_SUPPORTED', f'暂不支持的 Lazada 站点：{u.netloc}')

    m = re.search(r'/shop/([^/?]+)', u.path)
    slug = m.group(1).strip('/') if m else None
    item_ids = re.findall(r'itemId=(\d+)', url)
    if not slug and not item_ids:
        raise LazadaError('INVALID_PRODUCT_IDENTIFIER',
                          '链接中未识别出店铺（/shop/<slug>）或商品（itemId）')
    return {
        'shop': {'slug': slug, 'url': f'https://www.lazada.{_tld_of(host)}' + (f'/shop/{slug}/' if slug else ''),
                 'externalId': slug, 'countryCode': country, 'name': None},
        'itemIds': item_ids,
        'rawInput': {'url': url},
    }


def _tld_of(host):
    m = re.search(r'lazada\.(.+)$', host)
    return m.group(1) if m else 'com'


def _load_cookies():
    try:
        with open(LAZADA_COOKIE_FILE, encoding='utf-8') as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError, ValueError):
        return None


def save_cookies(cookies):
    with open(LAZADA_COOKIE_FILE, 'w', encoding='utf-8') as f:
        json.dump(cookies, f, ensure_ascii=False)


def browser_context(p, headless=True):
    """启动浏览器与上下文（去自动化特征 + 已保存的验证 Cookie）。"""
    browser = p.chromium.launch(
        headless=headless,
        args=['--disable-blink-features=AutomationControlled'])
    ctx = browser.new_context(
        locale='en-US',
        user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                   '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36')
    cookies = _load_cookies()
    if cookies:
        try:
            ctx.add_cookies(cookies)
        except Exception:
            pass  # Cookie 失效时按未验证流程走
    return browser, ctx


def is_punish(url):
    return '_____tmd_____' in url or '/punish' in url


def fetch_html(url, wait_dom_timeout=60000, headless=True):
    """加载页面并返回最终 HTML；被风控拦截时抛 SOURCE_LOGIN_REQUIRED（由操作者人工验证）。"""
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        raise LazadaError('INTERNAL_ERROR', '未安装 playwright，无法抓取 Lazada')
    with sync_playwright() as p:
        browser, ctx = browser_context(p, headless=headless)
        page = ctx.new_page()
        try:
            page.goto(url, wait_until='domcontentloaded', timeout=wait_dom_timeout)
            # punish 页由 JS 自动跳转，轮询等待最多 10s
            for _ in range(10):
                if not is_punish(page.url):
                    break
                time.sleep(1)
            if is_punish(page.url):
                raise LazadaError('SOURCE_LOGIN_REQUIRED',
                                  'Lazada 需要人工滑块验证：请点击「打开验证窗口」完成滑块后重试')
            time.sleep(3)  # 等待 React 数据渲染
            return page.content()
        finally:
            browser.close()


def _page_json(page, url):
    """在页面上下文内发起同源请求（复用验证 Cookie 与风控指纹），返回 JSON。"""
    raw = page.evaluate(
        """async (u) => { const r = await fetch(u, {headers: {'accept': 'application/json'}});
                           return await r.text(); }""", url)
    return json.loads(raw)


def resolve_store(url):
    """店铺链接 → {shop, products:[{externalId,name,url,price,rating}]}。"""
    parsed = parse_store_url(url)
    shop = parsed['shop']
    host = urlparse(url).netloc
    html = fetch_html(url)
    # 店铺信息
    m = re.search(r'"sellerId"\s*:\s*(\d+)', html)
    if m:
        shop['externalId'] = m.group(1)
    m = re.search(r'"shopName"\s*:\s*"([^"]+)"', html)
    if m:
        shop['name'] = json.loads(f'"{m.group(1)}"')

    if not shop['slug']:
        raise LazadaError('VALIDATION_ERROR', '链接中未识别出店铺 slug')
    if not shop['externalId']:
        raise LazadaError('SOURCE_BLOCKED', '未能从店铺页解析出 sellerId（可能被风控拦截）')

    # 商品列表：店铺页 ?ajax=true 分页 JSON（在页面上下文请求以复用风控 Cookie）
    products, page_no = [], 1
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            browser, ctx = browser_context(p, headless=True)
            page = ctx.new_page()
            page.goto(f'https://www.lazada.{_tld_of(host)}/shop/{shop["slug"]}/',
                      wait_until='domcontentloaded', timeout=60000)
            for _ in range(10):
                if not is_punish(page.url):
                    break
                time.sleep(1)
            if is_punish(page.url):
                raise LazadaError('SOURCE_LOGIN_REQUIRED',
                                  'Lazada 需要人工滑块验证：请点击「打开验证窗口」完成滑块后重试')
            time.sleep(2)
            seen = set()
            while page_no <= 10:
                data = _page_json(page, f'https://www.lazada.{_tld_of(host)}/shop/{shop["slug"]}'
                                        f'?ajax=true&page={page_no}')
                items = ((data.get('mods') or {}).get('listItems')) or []
                new = 0
                for it in items:
                    iid = str(it.get('itemId') or '')
                    if not iid or iid in seen:
                        continue
                    seen.add(iid)
                    new += 1
                    products.append({
                        'externalId': iid,
                        'name': it.get('name'),
                        'url': f'https://www.lazada.{_tld_of(host)}/product/i{iid}.html',
                        'price': it.get('priceShow') or it.get('price'),
                        'rating': it.get('ratingScore'),
                        'reviews': it.get('review'),
                    })
                if not new:
                    break
                page_no += 1
            browser.close()
    except LazadaError:
        raise
    except Exception:
        products = []  # 商品列表失败不阻断店铺解析，详情阶段可手动添加商品

    return {'shop': shop, 'products': products[:60],
            'warnings': ([] if products else ['店铺商品列表获取失败，可手动添加商品'])}


def resolve_product(identifier, country_tld='com.my', detail=True):
    """商品 itemId 或链接 → §10.2 详情 + 评价（PDP 评论区公开可见）。"""
    if identifier.startswith('http'):
        u = urlparse(identifier)
        m = re.search(r'-(i?)(\d+)\.html', u.path) or re.search(r'itemId=(\d+)', identifier)
        item_id = (m.group(2) if m and m.group(2) else m.group(1)) if m else None
        host = u.netloc
    else:
        item_id = str(identifier).strip()
        host = None
    if not item_id or not item_id.isdigit():
        raise LazadaError('INVALID_PRODUCT_IDENTIFIER', f'不是有效的 Lazada 商品 ID 或链接：{identifier}')
    tld = _tld_of(host) if host else country_tld
    html = fetch_html(f'https://www.lazada.{tld}/product/i{item_id}.html')
    try:
        import os
        os.makedirs('raw_html', exist_ok=True)
        with open(f'raw_html/lazada_pdp_{item_id}.html', 'w', encoding='utf-8') as f:
            f.write(html)
    except OSError:
        pass  # 落盘仅用于解析迭代排查

    # PDP 数据在 window.pageData 中
    m = re.search(r'window\.pageData\s*=\s*(\{.*?\})\s*</script>', html, re.S)
    module = {}
    if m:
        try:
            data = json.loads(m.group(1))
            module = data.get('module') or {}
        except json.JSONDecodeError:
            module = {}
    title = module.get('name')
    price_text = (module.get('price') or {}).get('price') if isinstance(module.get('price'), dict) else module.get('price')
    images = [i for i in [module.get('mainImage')] + list(module.get('image') or []) if i]
    rating = module.get('ratingScore')
    rating_count = module.get('review')

    detail = {
        'id': None,
        'platform': 'lazada',
        'countryCode': LAZADA_TLD_COUNTRY.get(tld, tld.upper()),
        'externalId': item_id,
        'url': f'https://www.lazada.{tld}/product/i{item_id}.html',
        'title': title,
        'price': {'amount': re.sub(r'[^\d.]', '', str(price_text)) or None,
                  'currency': {'MY': 'MYR', 'TH': 'THB', 'PH': 'PHP', 'SG': 'SGD', 'ID': 'IDR', 'VN': 'VND'}.get(LAZADA_TLD_COUNTRY.get(tld, ''), None)},
        'referenceImages': [{'url': u, 'type': 'main' if i == 0 else 'gallery'} for i, u in enumerate(images)],
        'rating': {'value': str(rating) if rating else None, 'scale': '5',
                   'count': rating_count},
        'brand': (module.get('brandName') or None),
        'model': None,
        'attributes': None,
        'store': None,
        'variants': None,
        'sourcePublishedAt': None,
        'collectedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'raw': {'discoveredVia': 'input'},
    }
    if detail:
        detail['reviews'] = _extract_reviews(html, item_id, tld)
        detail['latestReviewAt'] = next(
            (r['reviewedAt'] for r in detail['reviews'] if r.get('reviewedAt')), None)
    return detail


def _extract_reviews(html, item_id, tld):
    """从 PDP HTML 提取评价（Lazada 评价公开可见）。

    PDP 的评价由懒加载接口返回（JSON 内嵌 HTML），成功加载时页面/接口响应中含
    review 卡片（nickname/star/date/content/sku/images）。此处兼容两种来源：
    1) PDP 首屏 HTML 内嵌的评价；2) 评价接口响应文本。
    """
    reviews = []
    # Lazada 评价卡片常见结构（新旧版混合匹配，宽松提取）
    blocks = re.split(r'class="(?:review-item|item-content[_\w-]*)"', html)
    for b in blocks[1:]:
        nick = _txt(b, r'class="nickname[^"]*"[^>]*>([^<]+)<')
        star = _txt(b, r'ratingStar[^>]*>|star-([\d]+)-0-\d+')
        date = _txt(b, r'class="title[^"]*"[^>]*>([^<]+)<')
        content = _txt(b, r'class="content[^"]*"[^>]*>([^<]+)<')
        sku = _txt(b, r'class="sku-info[^"]*"[^>]*>([^<]+)<')
        if not (nick or content):
            continue
        reviews.append({
            'externalId': None,
            'nickname': nick,
            'rating': star,
            'title': None,
            'content': content,
            'images': None,
            'videos': None,
            'region': None,
            'reviewedAt': None,
            'reviewedAtText': date,
            'variant': sku,
            'verifiedPurchase': False,
            'helpfulCount': 0,
        })
    return reviews


def _txt(html, pattern):
    m = re.search(pattern, html)
    return m.group(1).strip() if m else None
