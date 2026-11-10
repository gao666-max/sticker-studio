import http.server
import os
import socketserver
import webbrowser

os.chdir(os.path.dirname(os.path.abspath(__file__)))


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


class ReusableServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True


def main():
    httpd = None
    port = 8787
    for candidate in range(8787, 8800):
        try:
            httpd = ReusableServer(("127.0.0.1", candidate), Handler)
            port = candidate
            break
        except OSError:
            continue
    if httpd is None:
        raise SystemExit("端口 8787-8799 都被占用，请先关闭占用进程。")

    url = f"http://127.0.0.1:{port}/"
    print(f"旗袍表情工坊已启动: {url}")
    print("按 Ctrl+C 停止。")
    try:
        webbrowser.open(url)
    except Exception:
        pass
    with httpd:
        httpd.serve_forever()


if __name__ == "__main__":
    main()
