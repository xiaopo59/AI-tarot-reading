"""
临时脚本（用完即删）：多线程的静态文件服务。

为什么不用 `python -m http.server`：它是**单线程**的。手机下载 260KB 的 APK 时，
如果同时还有人请求 index.html，后一个请求会一直等前一个传完；
再赶上连接没正常关闭，就会卡到超时。这在「一边下载 APK 一边开着网页」时很容易撞上。

ThreadingHTTPServer 每个请求一个线程，就不存在这个问题了。

    python serve.py
"""
import http.server
import os
import socketserver
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
HERE = os.path.dirname(os.path.abspath(__file__))
os.chdir(HERE)


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # 开发期禁止缓存，免得改了文件手机还在看旧的
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        super().end_headers()

    def log_message(self, fmt, *args):
        # 只记错误，正常请求不刷屏
        status = args[1] if len(args) > 1 else ''
        if str(status).startswith(('4', '5')):
            sys.stderr.write('  %s %s\n' % (self.address_string(), fmt % args))


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == '__main__':
    import socket

    # 强制 stdout 用 UTF-8，且编码失败时替换而不是抛异常。
    # Windows 上 Python 输出到管道/重定向时用的是 locale 编码（这里通常是 GBK），
    # 而调用方的解码方式未必一致，中文就可能变成一串替换字符。
    if hasattr(sys.stdout, 'reconfigure'):
        try:
            sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        except (ValueError, OSError):
            pass

    def lan_ips():
        """列出本机的局域网 IPv4 地址。

        为什么要列出来：这台机器的地址是 DHCP 分配的，会在 192.168.1.x 之间变，
        而手机上要输入的就是这个地址。不打印的话每次都得手动 ipconfig 查。
        （实际遇到过：文档里写的是 .7，而机器已经变成 .12，于是手机连不上，
         还以为是防火墙问题。）
        """
        found = []
        try:
            # 连一个外网地址不会真的发包，只是让系统挑出默认出口网卡
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(('8.8.8.8', 80))
            found.append(s.getsockname()[0])
            s.close()
        except OSError:
            pass
        try:
            for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
                ip = info[4][0]
                if ip not in found and not ip.startswith('127.'):
                    found.append(ip)
        except OSError:
            pass
        return found

    with Server(('0.0.0.0', PORT), Handler) as httpd:
        # 标签带 ASCII 版本：万一终端编码不对，中文变成乱码，
        # 地址本身仍然能认出来（这是这个脚本唯一真正重要的输出）。
        print('服务已启动 / serving: %s' % HERE)
        print('')
        print('  local:  http://127.0.0.1:%d/' % PORT)
        for ip in lan_ips():
            print('  phone:  http://%s:%d/' % (ip, PORT))
        print('')
        print('（phone 那行就是手机上要输入的地址，需和电脑连同一个 Wi-Fi）')
        print('（press Ctrl+C to stop）')
        sys.stdout.flush()
        httpd.serve_forever()
