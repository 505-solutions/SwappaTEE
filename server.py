from http.server import HTTPServer, BaseHTTPRequestHandler

class SimpleHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-type', 'text/plain')
        self.end_headers()
        self.wfile.write(b"OK")

def run_server():
    server_address = ('', 3000)
    httpd = HTTPServer(server_address, SimpleHandler)
    print("Server running on port 3000...")
    httpd.serve_forever()

if __name__ == '__main__':
    run_server() 