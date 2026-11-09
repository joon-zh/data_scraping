# -*- coding: utf-8 -*-
"""Amazon 店铺解析与商品详情抓取。

依据 PRODUCT_SPEC.md：
- §9.3 定位模型：输入店铺 URL → 解析出 store{name,url,externalId,countryCode}，原始输入与规范化结果分别保存。
- §10.2 统一商品详情模型：标题/图片/评分/规格售价/品牌型号/链接/店铺，金额为定点字符串+ISO4217 币种，
  不可获取字段为 null（不造虚假默认值），collectedAt 为 UTC ISO 8601。
- §17.3 原始数据：可用 --html-dir 保存原始 HTML 供审计重放。

实现说明：店铺页 HTML 中仅包含首屏商品（Amazon 品牌旗舰店页面其余商品由 AJAX 分批加载），
本工具提取首屏 ASIN 后逐个抓取 /dp 详情页。仅面向公开页面，请遵守目标平台服务条款（§18.3）。

用法：
  python amazon_scraper.py <店铺或商品URL> [--max-products 5] [--out out.json]
                           [--html-dir raw_html] [--delay 2.0]
"""

import argparse
import json
import re
import sys
import time
from datetime import datetime, timezone
from html import unescape
from urllib.parse import urlparse, parse_qs, urlencode, quote
from urllib.request import getproxies

import requests

ASIN_RE = re.compile(r'^(B0[A-Z0-9]{8}|[A-Z0-9]{10})$')

# 域名后缀 → ISO 3166-1 alpha-2 国家码（§9.3）
TLD_COUNTRY = {
    'com': 'US', 'ca': 'CA', 'com.mx': 'MX', 'com.br': 'BR', 'co.uk': 'GB',
    'de': 'DE', 'fr': 'FR', 'it': 'IT', 'es': 'ES', 'nl': 'NL', 'se': 'SE',
    'pl': 'PL', 'be': 'BE', 'ie': 'IE', 'co.jp': 'JP', 'in': 'IN',
    'com.au': 'AU', 'ae': 'AE', 'sg': 'SG', 'sa': 'SA', 'eg': 'EG',
    'com.tr': 'TR', 'cn': 'CN',
}

# 国家 → 默认币种（ISO 4217）
COUNTRY_CURRENCY = {
    'US': 'USD', 'CA': 'CAD', 'MX': 'MXN', 'BR': 'BRL', 'GB': 'GBP',
    'DE': 'EUR', 'FR': 'EUR', 'IT': 'EUR', 'ES': 'EUR', 'NL': 'EUR',
    'BE': 'EUR', 'IE': 'EUR', 'SE': 'SEK', 'PL': 'PLN', 'JP': 'JPY',
    'IN': 'INR', 'AU': 'AUD', 'AE': 'AED', 'SG': 'SGD', 'SA': 'SAR',
    'EG': 'EGP', 'TR': 'TRY', 'CN': 'CNY',
}

# 小数逗号（欧陆格式 1.234,56）国家
COMMA_DECIMAL = {'DE', 'FR', 'IT', 'ES', 'NL', 'BE', 'IE', 'SE', 'PL', 'BR', 'TR'}

HEADERS = {
    'User-Agent': ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                   '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'),
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
}


class ScrapeError(Exception):
    """携带 PRODUCT_SPEC.md §12.5 风格错误码的抓取异常。"""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def make_session(country=None, netloc='www.amazon.com', cookie_string=None):
    s = requests.Session()
    s.headers.update(HEADERS)
    s.trust_env = True  # 读取系统代理（getproxies 生效）
    domain = '.' + netloc.removeprefix('www.')
    if country:
        # 让 Amazon 按店铺站点币种渲染价格（否则按 IP 地理显示，如 HKD）
        s.cookies.set('i18n-prefs', COUNTRY_CURRENCY.get(country, 'USD'), domain=domain)
    if cookie_string:
        # 操作者浏览器复制的 Cookie（"name=value; name2=value2"），用于通过评价页登录墙
        for part in cookie_string.split(';'):
            name, _, value = part.strip().partition('=')
            if name:
                s.cookies.set(name, value, domain=domain)
    return s


def fetch(session, url, timeout=30, retries=3):
    """带重试地抓取页面；识别验证码/封锁页。"""
    last = None
    for attempt in range(retries):
        try:
            resp = session.get(url, timeout=timeout)
        except requests.RequestException as e:
            last = e
            time.sleep(2 ** attempt)
            continue
        if resp.status_code == 200:
            text = resp.text
            if 'api-services-support@amazon.com' in text or '<title>Robot Check' in text:
                raise ScrapeError('SOURCE_BLOCKED', '目标平台返回验证码/机器人校验页，已停止抓取')
            return text
        if resp.status_code in (404, 410):
            raise ScrapeError('PRODUCT_NOT_FOUND', f'页面不存在（404）：{url}')
        last = ScrapeError('RATE_LIMITED' if resp.status_code == 503 else 'INTERNAL_ERROR',
                           f'HTTP {resp.status_code}：{url}')
        time.sleep(2 ** attempt)
    raise last or ScrapeError('INTERNAL_ERROR', f'抓取失败：{url}')


# ---------------------------------------------------------------- 定位解析（§9.3）

def country_from_host(host):
    host = host.lower()
    if host.startswith('www.'):
        host = host[4:]
    if host in ('amazon.com', 'amzn.com', 'amzn.to'):
        return 'US'
    if host.startswith('amazon.'):
        suffix = host[len('amazon.'):]
        return TLD_COUNTRY.get(suffix)
    for suffix, country in sorted(TLD_COUNTRY.items(), key=lambda kv: -len(kv[0])):
        if host.endswith('.' + suffix):
            return country
    return None


def parse_store_url(url):
    """店铺 URL → 定位模型；商品 URL 也可作为退化的单店铺输入。"""
    u = urlparse(url)
    if u.scheme not in ('http', 'https') or 'amazon.' not in u.netloc:
        raise ScrapeError('VALIDATION_ERROR', f'不是有效的 Amazon 链接：{url}')
    country = country_from_host(u.netloc)
    if not country:
        raise ScrapeError('COUNTRY_NOT_SUPPORTED', f'暂不支持的站点：{u.netloc}')

    store = {
        'name': None,
        'url': f'https://{u.netloc}{u.path}',
        'externalId': None,
        'countryCode': country,
    }
    products = []
    m = re.search(r'/stores/([^/]+)/page/([A-Za-z0-9-]+)', u.path)
    if m:
        store['name'] = unescape(m.group(1))
        store['externalId'] = m.group(2)
    asin_params = parse_qs(u.query).get('lp_asin') or []
    for asin in asin_params:
        asin = asin.upper()
        if ASIN_RE.match(asin):
            products.append({'externalId': asin, 'url': dp_url(u.netloc, asin)})

    # 商品详情 URL 输入（/dp/ASIN）
    m = re.search(r'/(?:dp|gp/product)/([A-Z0-9]{10})', u.path.upper())
    if m:
        asin = m.group(1)
        store['name'] = store['name'] or None
        products.append({'externalId': asin, 'url': dp_url(u.netloc, asin)})

    if not store['name'] and not store['externalId'] and not products:
        raise ScrapeError('INVALID_PRODUCT_IDENTIFIER',
                          '链接中未识别出店铺（/stores/<name>/page/<id>）或商品（/dp/<ASIN>）')
    return {'store': store, 'products': products, 'rawInput': {'url': url}}


def dp_url(netloc, asin):
    return f'https://{netloc}/dp/{asin}'


# ---------------------------------------------------------------- 店铺页解析

def extract_store_products(html, netloc, max_products):
    """从页面 HTML 提取商品 ASIN（去重、保持出现顺序）。"""
    asins = []
    seen = set()

    def add(asin):
        if asin not in seen and ASIN_RE.match(asin):
            seen.add(asin)
            asins.append(asin)

    for asin in re.findall(r'data-asin="([A-Z0-9]{10})"', html):
        add(asin)
    for asin in re.findall(r'amazon\.[a-z.]+/(?:dp|gp/product)/([A-Z0-9]{10})', html):
        add(asin)
    return [{'externalId': a, 'url': dp_url(netloc, a)} for a in asins[:max_products]]


# ---------------------------------------------------------------- 商品详情解析（§10.2）

def text_of(pattern, html, flags=re.S):
    m = re.search(pattern, html, flags)
    return unescape(m.group(1)).strip() if m else None


def parse_price(text, country):
    """价格文本 → {amount: 定点字符串, currency: ISO4217}；无法解析返回 None。

    优先取文本中的 3 位币种前缀（如 "HKD8,962.83"，IP 地理定价时出现），
    否则按站点国家映射币种并按本地数字格式归一。
    """
    if not text:
        return None
    m = re.match(r'\s*([A-Z]{3})\s*([\d.,]+)', text)
    if m and m.group(1) in {c for c in COUNTRY_CURRENCY.values()} | {'HKD', 'TWD', 'NZD', 'ZAR', 'CZK', 'DKK', 'NOK', 'ILS', 'QAR', 'KWD', 'BHD', 'OMR', 'JOD'}:
        currency, num = m.group(1), m.group(2)
        num = num.replace(',', '')
    else:
        currency = COUNTRY_CURRENCY.get(country)
        m = re.search(r'([\d.,]+)', text)
        if not m or not currency:
            return None
        num = m.group(1)
        if country in COMMA_DECIMAL:
            num = num.replace('.', '').replace(',', '.')
        else:
            num = num.replace(',', '')
    if not re.match(r'^\d+(\.\d+)?$', num):
        return None
    integer, _, frac = num.partition('.')
    amount = f'{integer or "0"}.{(frac or "00").ljust(2, "0")[:2]}'
    return {'amount': amount, 'currency': currency}


def parse_rating(html):
    value = text_of(r'<span class="a-icon-alt">([\d.]+)\s+out of\s+5\s+stars</span>', html)
    if not value:
        return None
    count_text = text_of(r'id="acrCustomerReviewText"[^>]*>\s*\(?([\d,.]+)\)?', html)
    count = None
    if count_text:
        digits = re.sub(r'[.,]', '', count_text)
        count = int(digits) if digits.isdigit() else None
    return {'value': value, 'scale': '5', 'count': count}


def parse_attributes(html):
    """商品概览（po- 行）与附加信息表（prodDetTable）→ {字段: 值}。"""
    attributes = {}
    for k, v in re.findall(
            r'po-[a-z_]+"[^>]*>.*?a-text-bold">\s*([^<]+?)\s*</span>.*?po-break-word">\s*([^<]+?)\s*</span>',
            html, re.S):
        attributes.setdefault(unescape(k).strip(), unescape(v).strip())
    for k, v in re.findall(
            r'prodDetSectionEntry">\s*([^<]+?)\s*</th>\s*<td[^>]*>\s*([^<]+?)\s*</td>',
            html, re.S):
        attributes.setdefault(unescape(k).strip(), unescape(v).strip())
    return attributes


def parse_brand(html):
    # 品牌：byline 锚点 / 品牌 logo title / "Top Brand:" 标题，按可靠性顺序
    byline = text_of(r'<a id="bylineInfo"[^>]*>(.*?)</a>', html)
    if byline:
        name = re.sub(r'^(Visit the|Brand:)\s*', '', byline).replace(' Store', '').strip()
        if name:
            return name, byline
    logo_title = text_of(r'id="brandLogoHiResByline"[^>]*title="([^"]+)"', html)
    if logo_title:
        name = re.sub(r'^(Visit the|Brand:)\s*', '', logo_title).replace(' Store', '').strip()
        if name:
            return name, logo_title
    top = text_of(r'Top Brand:\s*([^<]+?)\s*<', html)
    if top:
        return top, f'Top Brand: {top}'
    return None, None


def parse_product(html, asin, url, country, store, discovered_via='input'):
    title = text_of(r'<span id="productTitle"[^>]*>\s*(.*?)\s*</span>', html)

    price = None
    price_text = text_of(r'<span class="a-price[^"]*"[^>]*>\s*<span class="a-offscreen">([^<]+)</span>', html)
    if price_text:
        price = parse_price(price_text, country)

    images = []
    for u in re.findall(r'"hiRes":"(https://[^"]+?)"', html) or re.findall(r'"large":"(https://[^"]+?)"', html):
        if u not in images:
            images.append(u)
    if not images:
        images = re.findall(r'property="og:image" content="([^"]+)"', html)
    reference_images = [{'url': u, 'type': 'main' if i == 0 else 'gallery'} for i, u in enumerate(images)]

    brand, byline = parse_brand(html)

    # 型号：概览表/附加信息表中的 Model Number > Item model number > Model Name
    attributes = parse_attributes(html)
    model = None
    for key in ('Model Number', 'Item model number', 'Model Name', 'Item Model Number'):
        if attributes.get(key):
            model = attributes[key]
            break

    # 变体：twister 的 dimensionValuesDisplayData {ASIN: [规格值...]}
    variants = []
    dv = re.search(r'"dimensionValuesDisplayData"\s*:\s*(\{.*?\})\s*[,}]', html)
    if dv:
        try:
            mapping = json.loads(dv.group(1).replace("'", '"'))
        except json.JSONDecodeError:
            mapping = {}
        for var_asin, dims in mapping.items():
            if not ASIN_RE.match(var_asin):
                continue
            name = ' / '.join(str(d) for d in dims) if isinstance(dims, list) else None
            variants.append({
                'externalId': var_asin,
                'name': name,
                'attributes': None,
                'price': price if var_asin == asin else None,  # 仅当前页 ASIN 有确切价格
            })

    return {
        'id': None,
        'platform': 'amazon',
        'countryCode': country,
        'externalId': asin,
        'url': url,
        'title': title,
        'price': price,
        'referenceImages': reference_images,
        'rating': parse_rating(html),
        'brand': brand,
        'model': model,
        'attributes': attributes or None,
        'store': store,
        'variants': variants or None,
        'sourcePublishedAt': None,
        'collectedAt': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'raw': {
            'byline': byline,
            'priceText': price_text,
            'discoveredVia': discovered_via,
            # 平台专有信息保留样例；完整 HTML 可通过 --html-dir 落盘（§17.3）
        },
    }


# ---------------------------------------------------------------- 评价解析（§10.3）

MONTHS_EN = {m: i + 1 for i, m in enumerate(
    ['january', 'february', 'march', 'april', 'may', 'june', 'july',
     'august', 'september', 'october', 'november', 'december'])}


def parse_review_date(text):
    """评价时间文本 → ISO 日期；英文 "on October 5, 2025" 可解析，其余返回 None。"""
    if not text:
        return None
    m = re.search(r'on\s+([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})', text)
    if m:
        month = MONTHS_EN.get(m.group(1).lower())
        if month:
            return f'{m.group(3)}-{month:02d}-{int(m.group(2)):02d}'
    m = re.search(r'(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})', text)
    if m:
        return f'{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}'
    return None


def word_to_num(w):
    return {'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5,
            'six': 6, 'seven': 7, 'eight': 8, 'nine': 9, 'ten': 10}.get(w, 0)


def parse_reviews(html):
    """评价页 HTML → 评价列表（§10.3 字段：文字/图片/视频、昵称、星级、地区、
    时间、购买型号、收货状态、点赞量）。"""
    reviews = []
    # 以 data-hook="review" 分块：前块尾部是本块的 <div id=...> 属性，本块到下一块为止
    parts = html.split('data-hook="review"')
    for i in range(1, len(parts)):
        attrs = parts[i - 1][-400:]
        mid = re.search(r'id="(R?[A-Za-z0-9_-]+)"[^>]*$', attrs)
        block = parts[i]
        # 评价页卡片含 review-body；详情页 medley 卡片含 reviewText；日期是共同标识
        if 'review-date' not in block:
            continue
        date_text = text_of(r'data-hook="review-date"[^>]*>(.*?)</span>', block)
        body_html = text_of(r'data-hook="review-body"[^>]*>(.*?)'
                            r'(?=<div[^>]*(?:data-hook="vote|class="review-footer)|<span class="cr-vote|\Z)', block)
        if not body_html:
            # 详情页 medley：正文在 reviewText 卡片内（含无障碍提示文案，需去除）
            m = re.search(r'data-hook="reviewText"[^>]*>(.*?)'
                          r'(?=<div[^>]*helpful-votes-container|<span data-hook="helpful-vote-statement"|\Z)',
                          block, re.S)
            if m:
                body_html = re.sub(r'(?:Brief|Full) content visible, double tap to read (?:full|brief) content\.',
                                   ' ', m.group(1))
                # medley 展开控件、举报与反馈文案样板
                body_html = re.sub(
                    r'<a[^>]*>\s*Report\s*</a>|Read (?:more|less)|Translate review[^<]*', ' ', body_html)
                # 卡片尾部内嵌"举报"对话框等隐藏内容，从标记处截断
                m2 = re.search(r"reportAbuseConfirmationDialog|We'll check if this review meets"
                               r"|Sorry, We failed to report|Sending feedback", body_html)
                if m2:
                    body_html = body_html[:m2.start()]
        # 点赞数：他人认为该评论有用的人数（"215 people found this helpful"/"One person..."）
        helpful_text = (text_of(r'data-hook="helpful-vote-statement"[^>]*>([^<]+)', block)
                        or text_of(r'cr-helpful-button[^>]*>\s*<span[^>]*>([^<]+)', block) or '')
        helpful_digits = re.sub(r'[.,]', '', re.search(r'([\d.,]+)', helpful_text).group(1)) \
            if re.search(r'[\d]', helpful_text) else None
        if helpful_digits is None:
            # 英文数字词（"One person found this helpful"）或仅"Helpful"（无人点赞）
            word = re.search(r'\b(one|two|three|four|five|six|seven|eight|nine|ten)\b', helpful_text, re.I)
            helpful_digits = str(word_to_num(word.group(1).lower())) if word \
                else ('1' if re.search(r'person|一人', helpful_text, re.I) else '0')
        # 评价图片：评价页图片瓦片 / 详情页 medley 缩略图，避免占位像素图与头像
        images = re.findall(r'data-hook="review-image-tile"[^>]*src="(https://[^"]+)"', block)
        if not images:
            images = re.findall(
                r'class="[^"]*media-popover-thumbnail[^"]*"[^>]*src="(https://[^"]+)"', block)
        if not images and body_html:
            for src in re.findall(r'<img[^>]+src="(https://[^"]+)"', body_html):
                if not re.search(r'sprite|play-icon|transparent-pixel|amazon-avatars|/.{1,2}\.gif', src):
                    images.append(src)
        images = list(dict.fromkeys(images))  # 去重、保持顺序
        videos = re.findall(r'<source[^>]+src="(https://[^"]+\.mp4[^"]*)"', block)
        title = text_of(r'data-hook="review-title"[^>]*>(.*?)</a>', block)
        if not title:
            # 详情页 medley 的标题钩子
            title = text_of(r'data-hook="reviewTitle"[^>]*>(.*?)</h5>', block)
        if title:
            title = re.sub(r'\s*[\d.]+ out of 5 stars\s*', '', re.sub(r'<[^>]+>', ' ', title)).strip()
        reviews.append({
            'externalId': mid.group(1) if mid else None,
            'nickname': text_of(r'class="a-profile-name">([^<]+)<', block),
            'rating': text_of(r'data-hook="review-star".*?<span class="a-icon-alt">([\d.]+)', block)
                      or text_of(r'data-hook="review-star-rating"[^>]*>\s*<span class="a-icon-alt">([\d.]+)', block),
            'title': title or None,
            'content': re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' ', body_html or '')).strip() or None,            'images': images or None,
            'videos': videos or None,
            'region': (lambda m: m.group(1).strip() if m else None)(re.search(r'[Rr]eviewed in (.+?)\s+on\s', date_text or '')),
            'reviewedAt': parse_review_date(date_text),
            'reviewedAtText': date_text,
            'variant': text_of(r'class="cr-review-variant-subtext"[^>]*>\s*([^<]+)', block)
                       or text_of(r'data-hook="review-format-strip"[^>]*>\s*([^<]+)', block)
                       or re.sub(r'\s+', ' ', re.sub(
                           r'<[^>]+>', ' ',
                           text_of(r'data-hook="format-strip"[^>]*>(.*?)</a>', block) or '')).strip() or None,
            'verifiedPurchase': 'data-hook="avp-badge"' in block,
            'helpfulCount': int(helpful_digits) if helpful_digits.isdigit() else 0,
        })
    return reviews


def reviews_url(netloc, asin, page):
    # sortBy=recent：按最新排序（默认"最有用"排序下近期评论可能不在前几页）
    return f'https://{netloc}/product-reviews/{asin}/?pageNumber={page}&sortBy=recent'


def scrape_reviews(session, asin, netloc, max_pages=3, html_dir=None):
    """抓取商品评价页（默认前 3 页、按最新排序）；无评价返回空列表，
    命中登录墙抛 SOURCE_LOGIN_REQUIRED（由操作者提供 Cookie 解决）。

    翻页失效或重复返回时按 externalId 去重，某页无新评价即停止。"""
    out, seen = [], set()
    for page in range(1, max_pages + 1):
        html = fetch(session, reviews_url(netloc, asin, page))
        if html_dir:
            save_html(html_dir, f'{asin}_reviews_p{page}.html', html)
        if page == 1 and re.search(r'<title[^>]*>\s*(?:Amazon\s+)?Sign in', html):
            # Amazon 对匿名会话返回登录墙：要求操作者登录并提供 Cookie
            raise ScrapeError('SOURCE_LOGIN_REQUIRED',
                              '评价页需要登录 Amazon：请在浏览器登录后复制该站点 Cookie，'
                              '粘贴到「评价需要登录」输入框再重试')
        found = parse_reviews(html)
        new = [r for r in found if r['externalId'] and r['externalId'] not in seen]
        if not new:
            break  # 翻页无新评价（平台翻页参数失效或已到末页）
        seen.update(r['externalId'] for r in new)
        out.extend(new)
        if page < max_pages:
            time.sleep(1.0)  # 翻页礼貌间隔
    return out


# ---------------------------------------------------------------- 主流程

def scrape(session, parsed, max_products, delay, html_dir):
    store = dict(parsed['store'])
    asin_products = list(parsed['products'])
    discovered_via = 'input'

    if store.get('externalId') or store.get('name'):
        netloc = urlparse(parsed['rawInput']['url']).netloc
        store_html = fetch(session, parsed['rawInput']['url'])
        if html_dir:
            save_html(html_dir, 'store.html', store_html)
        found = extract_store_products(store_html, netloc, max_products)

        # 店铺页为 React 壳、初始 HTML 不含商品时，退化为品牌搜索页发现商品
        if not found and store.get('name'):
            found = brand_search_products(session, netloc, store['name'], max_products, html_dir)
            discovered_via = 'brand_search'

        merged = {p['externalId']: p for p in asin_products}
        for p in found:
            p['discoveredVia'] = discovered_via
            merged.setdefault(p['externalId'], p)
        asin_products = list(merged.values())[:max_products]

    products = []
    for i, p in enumerate(asin_products):
        html = fetch(session, p['url'])
        if html_dir:
            save_html(html_dir, f'{p["externalId"]}.html', html)
        detail = parse_product(html, p['externalId'], p['url'], store['countryCode'],
                               {'externalId': store.get('externalId'), 'name': store.get('name'),
                                'url': store.get('url')},
                               discovered_via=p.get('discoveredVia', 'input'))
        products.append(detail)
        if i < len(asin_products) - 1:
            time.sleep(delay)  # 礼貌间隔，降低被限流概率
    warnings = []
    if any(p.get('discoveredVia') == 'brand_search' for p in asin_products):
        warnings.append('店铺页初始 HTML 未包含商品（AJAX 加载），已改用品牌搜索页发现商品，结果为近似全店商品')
    return store, products, warnings


def brand_search_products(session, netloc, name, max_products, html_dir=None, max_pages=10):
    """品牌搜索页翻页发现商品，直到凑满 max_products 或某页无新 ASIN。"""
    found, seen = [], set()
    for page in range(1, max_pages + 1):
        search_url = f'https://{netloc}/s?k={quote(name)}&page={page}'
        html = fetch(session, search_url)
        if html_dir:
            save_html(html_dir, f'store_search_p{page}.html', html)
        new = [p for p in extract_store_products(html, netloc, max_products)
               if p['externalId'] not in seen]
        if not new:
            break
        for p in new:
            seen.add(p['externalId'])
            found.append(p)
        if len(found) >= max_products:
            break
        time.sleep(1.0)  # 翻页礼貌间隔
    return found[:max_products]


def harvest_dp_reviews_browser(asin, netloc='www.amazon.com', cookies=None, html_dir=None):
    """用 Playwright 加载商品详情页评论区（登录态），滚动至稳定后返回页面 HTML。

    详情页评论区包含"Top reviews from other countries"（其他国家/地区的热门评论），
    这些评价不出现在评价页列表中。cookies 为登录 Cookie 字典列表（saved_login_cookies）
    或 Cookie 字符串。playwright 未安装或加载失败返回 None。"""
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        return None
    domain = '.' + netloc.removeprefix('www.')
    items = None
    if isinstance(cookies, list):
        # secure 必须为 True：__Secure- 前缀的 Cookie 缺该属性会被浏览器拒绝
        items = [{'name': c['name'], 'value': c['value'], 'domain': domain, 'path': '/', 'secure': True}
                 for c in cookies if c.get('name') and c.get('value') is not None]
    elif isinstance(cookies, str) and cookies.strip():
        items = []
        for part in cookies.split(';'):
            name, _, value = part.strip().partition('=')
            if name:
                items.append({'name': name, 'value': value, 'domain': domain, 'path': '/', 'secure': True})
    html = None
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            ctx = browser.new_context(locale='en-US')
            if items:
                ctx.add_cookies(items)
            page = ctx.new_page()
            page.goto(f'https://{netloc}/dp/{asin}', wait_until='domcontentloaded', timeout=40000)
            try:
                page.locator('#reviewsMedley').scroll_into_view_if_needed(timeout=8000)
            except Exception:
                pass  # 无评论区（商品无评价）时直接收尾
            last, stable = -1, 0
            for _ in range(12):
                time.sleep(2)
                n = page.locator('[data-hook="review"]').count()
                if n == last:
                    stable += 1
                    if stable >= 3:
                        break
                else:
                    stable, last = 0, n
                page.evaluate('window.scrollBy(0, 2000)')
            html = page.content()
            browser.close()
    except Exception:
        # 输出到解析服务日志便于排查；调用方按 None 处理
        import traceback
        traceback.print_exc()
        return None
    if html_dir and html:
        save_html(html_dir, f'{asin}_dp_reviews.html', html)
    return html


def save_html(html_dir, name, html):
    import os
    os.makedirs(html_dir, exist_ok=True)
    with open(os.path.join(html_dir, name), 'w', encoding='utf-8') as f:
        f.write(html)


def main(argv=None):
    ap = argparse.ArgumentParser(description='Amazon 店铺解析与商品抓取（PRODUCT_SPEC.md §9/§10）')
    ap.add_argument('url', help='店铺链接（/stores/...）或商品链接（/dp/ASIN）')
    ap.add_argument('--max-products', type=int, default=5, help='最多抓取商品数（默认 5）')
    ap.add_argument('--out', default=None, help='结果 JSON 输出路径（默认打印到 stdout）')
    ap.add_argument('--html-dir', default=None, help='保存原始 HTML 的目录（§17.3 审计用）')
    ap.add_argument('--delay', type=float, default=2.0, help='商品间抓取间隔秒数')
    ap.add_argument('--cookies', default=None, help='浏览器复制的 Cookie 字符串（通过评价页登录墙）')
    args = ap.parse_args(argv)

    try:
        parsed = parse_store_url(args.url)
        session = make_session(parsed['store']['countryCode'],
                               urlparse(args.url).netloc, cookie_string=args.cookies)
        store, products, warnings = scrape(session, parsed, args.max_products, args.delay, args.html_dir)
    except ScrapeError as e:
        print(json.dumps({'error': {'code': e.code, 'message': str(e)}, 'requestId': None},
                         ensure_ascii=False, indent=2))
        return 1

    result = {
        'store': store,  # 规范化定位结果（§9.3），原始输入见 rawInput
        'products': products,
        'meta': {
            'requestedProducts': args.max_products,
            'collectedProducts': len(products),
            'warnings': warnings + ([
                '店铺页仅返回首屏商品，全店商品需要 AJAX 翻页支持'
            ] if store.get('externalId') and not warnings else []),
            'collectedAt': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        },
        'rawInput': parsed['rawInput'],
    }

    out = json.dumps(result, ensure_ascii=False, indent=2)
    if args.out:
        with open(args.out, 'w', encoding='utf-8') as f:
            f.write(out)
        print(f'已写入 {args.out}：店铺 {store.get("name") or store.get("externalId")}，'
              f'商品 {len(products)} 个')
    else:
        print(out)
    return 0


if __name__ == '__main__':
    sys.exit(main())
