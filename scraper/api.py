# -*- coding: utf-8 -*-
"""解析服务 API：把 amazon_scraper 暴露为本地 HTTP 接口，供前端调用。

接口（路径遵循 PRODUCT_SPEC.md §12，均为 POST，JSON）：
  POST /api/v1/stores/resolve   {"platform":"amazon","url":"...","maxProducts":5}
                                → {"data":{"store":{...},"products":[{"externalId","name","url"}],"warnings":[]}}
  POST /api/v1/products/resolve {"platform":"amazon","identifier":"B0XXXXXX 或商品URL",
                                 "detail":true}   # detail=true 返回 §10.2 完整商品详情
                                → {"data":{...}}
  POST /api/v1/login            弹出浏览器窗口供操作者登录 Amazon，登录态自动保存
  POST /api/v1/login/status     {"status":"running|ok|cancelled|error","message":"..."}

错误格式（§12.5）：
  {"error":{"code":"...","message":"..."},"requestId":null}

启动：python api.py [--port 8765]
"""

import argparse
import json
import os
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse



import base64

import requests

import amazon_scraper as scraper
import lazada_scraper as lazada

# 仅允许代理亚马逊图片域名（供 Excel 导出嵌图下载）
MEDIA_DOMAINS = {'m.media-amazon.com', 'images-na.ssl-images-amazon.com'}


def fetch_media(urls):
    """批量下载图片并 base64 返回 {url: {b64, contentType}}；单图失败跳过不阻断。"""
    out = {}
    sess = scraper.make_session()
    for u in (urls or [])[:60]:
        p = urlparse(u)
        if p.scheme != 'https' or p.netloc not in MEDIA_DOMAINS:
            continue
        try:
            resp = sess.get(u, timeout=20)
            if resp.status_code == 200 and resp.content:
                out[u] = {'b64': base64.b64encode(resp.content).decode('ascii'),
                          'contentType': resp.headers.get('Content-Type', 'image/jpeg')}
        except requests.RequestException:
            continue
    return {'images': out}


def resolve_store(platform, url, max_products):
    if platform == 'lazada':
        r = lazada.resolve_store(url)
        return {
            'store': {'name': r['shop']['name'], 'externalId': r['shop']['externalId'],
                      'url': r['shop']['url'], 'countryCode': r['shop']['countryCode']},
            'products': [{'externalId': p['externalId'], 'name': p['name'], 'url': p['url']}
                         for p in r['products']],
            'warnings': r.get('warnings', []),
        }
    if platform != 'amazon':
        raise scraper.ScrapeError('PLATFORM_NOT_SUPPORTED', f'平台 {platform} 的解析服务暂未接入')
    parsed = scraper.parse_store_url(url)
    store = parsed['store']
    session = scraper.make_session(store['countryCode'], urlparse(url).netloc)
    _, details, warnings = scraper.scrape(session, parsed, max_products, 0.0, None)
    return {
        'store': store,
        'products': [
            {'externalId': p['externalId'], 'name': p['title'], 'url': p['url']}
            for p in details
        ],
        'warnings': warnings,
    }


def resolve_product(platform, identifier, detail=False, cookies=None, start_at=None, end_at=None,
                    objects=None):
    if platform == 'lazada':
        d = lazada.resolve_product(identifier, detail=detail)
        if detail and not isinstance(d.get('reviews'), list):
            d['reviews'] = []
        return d
    if platform != 'amazon':
        raise scraper.ScrapeError('PLATFORM_NOT_SUPPORTED', f'平台 {platform} 的解析服务暂未接入')
    identifier = (identifier or '').strip()
    if not identifier:
        raise scraper.ScrapeError('VALIDATION_ERROR', '请输入商品 ID 或商品链接')

    if identifier.startswith('http'):
        parsed = scraper.parse_store_url(identifier)
        if not parsed['products']:
            raise scraper.ScrapeError('INVALID_PRODUCT_IDENTIFIER', '链接中未识别出商品 ASIN')
        target = parsed['products'][0]
        store = parsed['store']
    elif scraper.ASIN_RE.match(identifier.upper()):
        asin = identifier.upper()
        target = {'externalId': asin, 'url': scraper.dp_url('www.amazon.com', asin)}
        store = None
    else:
        raise scraper.ScrapeError('INVALID_PRODUCT_IDENTIFIER', f'不是有效的 Amazon 商品 ID 或链接：{identifier}')

    country = (store or {}).get('countryCode') or 'US'
    # 登录态：请求自带 Cookie 字符串优先；否则用弹窗登录保存的 Cookie（字符串给 requests、列表给浏览器采集）
    cookie_list = None
    if not cookies:
        cookie_list = saved_login_cookies()
        if cookie_list:
            cookies = '; '.join(f"{c['name']}={c['value']}" for c in cookie_list)
    session = scraper.make_session(country, urlparse(target['url']).netloc, cookie_string=cookies)
    html = scraper.fetch(session, target['url'])
    detail_data = scraper.parse_product(html, target['externalId'], target['url'], country, store)
    if detail:
        # §10.2 完整出参；评价仅在前端勾选了「商品评价」采集对象时抓取（objects 为空视为全选）
        include_reviews = not objects or 'product_review' in objects
        netloc = urlparse(target['url']).netloc
        reviews = []
        if include_reviews:
            reviews, reviews_error = [], None
            try:
                reviews = scraper.scrape_reviews(session, target['externalId'], netloc)
            except (scraper.ScrapeError, lazada.LazadaError) as e:
                reviews_error = e
            # 详情页评论区补充采集：含"其他国家/地区"的热门评论（评价页列表不含）。
            # 评价页被拦但详情页评论可用时仍正常返回，两处都失败才上报 reviewsError
            try:
                dp_html = scraper.harvest_dp_reviews_browser(
                    target['externalId'], netloc,
                    cookies=cookie_list if cookie_list else cookies)
            except Exception:
                dp_html = None
            if dp_html:
                seen = {r['externalId'] for r in reviews if r['externalId']}
                reviews += [r for r in scraper.parse_reviews(dp_html)
                            if r['externalId'] and r['externalId'] not in seen]
            if reviews_error and not reviews:
                detail_data['reviewsError'] = {'code': reviews_error.code, 'message': str(reviews_error)}
        # 最新评价时间取过滤前的全部评价（评价按最新排序，第一条即最新；无评价为 null）
        detail_data['latestReviewAt'] = next(
            (r['reviewedAt'] for r in reviews if r.get('reviewedAt')), None)
        # 采集期间过滤：只保留 reviewedAt 落在 [startAt, endAt] 的评价（日期字符串可直接比较）
        start_day = (start_at or '')[:10]
        end_day = (end_at or '')[:10]
        if start_day or end_day:
            reviews = [r for r in reviews
                       if (not start_day or (r.get('reviewedAt') or '') >= start_day)
                       and (not end_day or (r.get('reviewedAt') or '9999') <= end_day)]
        detail_data['reviews'] = reviews
        return detail_data
    return {
        'externalId': detail_data['externalId'],
        'name': detail_data['title'],
        'url': detail_data['url'],
        'store': (store or detail_data['store']) and {
            'externalId': (store or detail_data['store']).get('externalId'),
            'name': (store or detail_data['store']).get('name'),
        },
    }


ROUTES = {
    '/api/v1/stores/resolve': lambda body: resolve_store(
        body.get('platform'), body.get('url'), int(body.get('maxProducts') or 5)),
    '/api/v1/products/resolve': lambda body: resolve_product(
        body.get('platform'), body.get('identifier'), bool(body.get('detail')),
        cookies=body.get('cookies'), start_at=body.get('startAt'), end_at=body.get('endAt'),
        objects=body.get('objects')),
    '/api/v1/login': lambda body: start_login(),
    '/api/v1/login/status': lambda body: dict(_login),
    '/api/v1/media': lambda body: fetch_media(body.get('urls')),
    '/api/v1/lazada/verify': lambda body: start_lazada_verify(),
    '/api/v1/lazada/verify/status': lambda body: dict(_lazada_verify),
}


# ---------------------------------------------------------------- Lazada 人工验证窗口

_lazada_verify = {'status': 'idle', 'message': '未验证'}


def start_lazada_verify():
    with _login_lock:
        if _lazada_verify['status'] == 'running':
            return dict(_lazada_verify)
        _lazada_verify.update(status='running', message='正在打开验证窗口…')
    threading.Thread(target=_run_lazada_verify, daemon=True).start()
    return dict(_lazada_verify)


def _run_lazada_verify():
    """弹出可见浏览器窗口，操作者完成 Lazada 滑块验证后自动保存 Cookie 并关窗。"""
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=False)
            ctx = browser.new_context(
                locale='en-US',
                user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                           '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36')
            page = ctx.new_page()
            page.goto('https://www.lazada.com.my/', wait_until='domcontentloaded', timeout=60000)
            _lazada_verify.update(message='请在窗口中完成滑块/安全验证，成功后窗口自动关闭')
            ok = False
            for _ in range(300):
                time.sleep(2)
                try:
                    if not lazada.is_punish(page.url) and page.title():
                        lazada.save_cookies(ctx.cookies())
                        _lazada_verify.update(status='ok', message='验证成功，Cookie 已保存')
                        ok = True
                        break
                except Exception:
                    pass
            if not ok:
                _lazada_verify.update(status='cancelled', message='验证未完成')
            try:
                browser.close()
            except Exception:
                pass
    except ImportError:
        _lazada_verify.update(status='error', message='未安装 playwright，无法弹出验证窗口')
    except Exception as e:
        _lazada_verify.update(status='error', message=f'验证窗口启动失败：{e}')


# ---------------------------------------------------------------- 登录窗口（评价页登录墙）

# 弹窗登录保存的 Cookie 文件（重启服务后仍可用）
LOGIN_COOKIE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'amazon_login_cookies.json')
_login_lock = threading.Lock()
_login = {'status': 'idle', 'message': '未登录'}
# Amazon 登录态以这几个 Cookie 为准（匿名会话没有）
SESSION_COOKIE_NAMES = {'at-main', 'x-main', 'sess-token'}


def saved_login_cookies():
    try:
        with open(LOGIN_COOKIE_FILE, encoding='utf-8') as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError, ValueError):
        return None


def _has_login_cookie(cookies):
    return bool({c.get('name') for c in cookies} & SESSION_COOKIE_NAMES)


def start_login():
    with _login_lock:
        if _login['status'] == 'running':
            return dict(_login)
        _login.update(status='running', message='正在打开登录窗口…')
    threading.Thread(target=_run_login, daemon=True).start()
    return dict(_login)


def _run_login():
    """弹出浏览器窗口，操作者登录后自动捕获登录态并落盘，窗口自动关闭。"""
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=False)
            ctx = browser.new_context(locale='en-US')
            page = ctx.new_page()
            # 完整 OpenID 参数的登录页（缺参数会被 Amazon 重定向到 404 页）
            signin_url = ('https://www.amazon.com/ap/signin?openid.pape.max_auth_age=0'
                          '&openid.return_to=https%3A%2F%2Fwww.amazon.com%2F%3Fref_%3Dnav_custrec_signin'
                          '&openid.identity=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select'
                          '&openid.assoc_handle=usflex&openid.mode=checkid_setup'
                          '&openid.claimed_id=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select'
                          '&openid.ns=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0')
            try:
                page.goto(signin_url, wait_until='domcontentloaded', timeout=30000)
            except Exception:
                page.goto('https://www.amazon.com/', wait_until='domcontentloaded')  # 兜底：手动点登录
            _login.update(message='登录窗口已打开，请在窗口中登录 Amazon（登录成功后窗口自动关闭）')
            try:
                while True:
                    cookies = ctx.cookies('https://www.amazon.com')
                    if _has_login_cookie(cookies):
                        with open(LOGIN_COOKIE_FILE, 'w', encoding='utf-8') as f:
                            json.dump(cookies, f, ensure_ascii=False)
                        _login.update(status='ok', message='登录成功，正在重新获取评价…')
                        break
                    if not browser.is_connected() or page.is_closed():
                        _login.update(status='cancelled', message='登录窗口已关闭，未完成登录')
                        return
                    page.wait_for_timeout(2000)
            except Exception:
                _login.update(status='cancelled', message='登录窗口已关闭，未完成登录')
                return
            finally:
                try:
                    browser.close()
                except Exception:
                    pass
    except ImportError:
        _login.update(status='error', message='未安装 playwright，无法弹出登录窗口（pip install playwright）')
    except Exception as e:
        _login.update(status='error', message=f'登录窗口启动失败：{e}')


class Handler(BaseHTTPRequestHandler):
    def _send(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):  # 前端跨域预检
        self._send(204, {})

    def do_POST(self):
        handler = ROUTES.get(self.path)
        if not handler:
            self._send(404, {'error': {'code': 'NOT_FOUND', 'message': f'未知接口：{self.path}'}, 'requestId': None})
            return
        try:
            length = int(self.headers.get('Content-Length') or 0)
            body = json.loads(self.rfile.read(length) or b'{}')
        except json.JSONDecodeError:
            self._send(400, {'error': {'code': 'VALIDATION_ERROR', 'message': '请求体不是有效 JSON'}, 'requestId': None})
            return
        try:
            self._send(200, {'data': handler(body), 'requestId': None})
        except (scraper.ScrapeError, lazada.LazadaError) as e:
            self._send(200, {'error': {'code': e.code, 'message': str(e)}, 'requestId': None})
        except Exception as e:  # 未预期异常统一兜底，不向客户端泄露堆栈
            self._send(500, {'error': {'code': 'INTERNAL_ERROR', 'message': f'解析服务内部错误：{e}'}, 'requestId': None})

    def log_message(self, fmt, *args):  # 安静模式：仅打印请求行
        print('[api]', self.address_string(), fmt % args)


def main():
    ap = argparse.ArgumentParser(description='解析服务 API')
    ap.add_argument('--port', type=int, default=8765)
    args = ap.parse_args()
    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    print(f'解析服务已启动：http://127.0.0.1:{args.port}')
    server.serve_forever()


if __name__ == '__main__':
    main()
