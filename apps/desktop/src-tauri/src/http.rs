//! 127.0.0.1 のデーモンだけと話す最小の HTTP/1.1 クライアント（依存を増やさないため。ADR 0010 の「Rust を最小に」）。
//! Bearer トークンで認証し、Origin は付けない（CLI と同じ扱い。desktop-shell.md 7章）。

use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

pub struct Response {
    pub status: u16,
    pub body: String,
}

fn connect(port: u16, read_timeout: Duration) -> io::Result<TcpStream> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let s = TcpStream::connect_timeout(&addr, Duration::from_secs(2))?;
    s.set_read_timeout(Some(read_timeout))?;
    s.set_write_timeout(Some(Duration::from_secs(5)))?;
    Ok(s)
}

fn write_request(
    s: &mut TcpStream,
    port: u16,
    method: &str,
    path: &str,
    token: &str,
    body: Option<&str>,
) -> io::Result<()> {
    let mut head = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\n\
         User-Agent: TurnlaneDesktop\r\nAccept: */*\r\nConnection: close\r\n"
    );
    if let Some(b) = body {
        head.push_str(&format!(
            "Content-Type: application/json\r\nContent-Length: {}\r\n",
            b.len()
        ));
    }
    head.push_str("\r\n");
    s.write_all(head.as_bytes())?;
    if let Some(b) = body {
        s.write_all(b.as_bytes())?;
    }
    s.flush()
}

/// ステータス行とヘッダを読み、本文の読み手を返す
fn read_head(mut r: BufReader<TcpStream>) -> io::Result<(u16, Body)> {
    let mut line = String::new();
    r.read_line(&mut line)?;
    let status = line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "bad status line"))?;
    let mut chunked = false;
    let mut length = None;
    loop {
        line.clear();
        if r.read_line(&mut line)? == 0 || line.trim().is_empty() {
            break;
        }
        let (k, v) = line.split_once(':').unwrap_or((&line, ""));
        let (k, v) = (k.trim().to_ascii_lowercase(), v.trim());
        if k == "transfer-encoding" && v.eq_ignore_ascii_case("chunked") {
            chunked = true;
        } else if k == "content-length" {
            length = v.parse::<u64>().ok();
        }
    }
    let body = match (chunked, length) {
        (true, _) => Body::Chunked(Chunked { inner: r, left: 0, done: false }),
        (false, Some(n)) => Body::Plain(r.take(n)),
        (false, None) => Body::Plain(r.take(u64::MAX)),
    };
    Ok((status, body))
}

pub enum Body {
    Chunked(Chunked),
    Plain(io::Take<BufReader<TcpStream>>),
}

impl Read for Body {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        match self {
            Body::Chunked(c) => c.read(buf),
            Body::Plain(p) => p.read(buf),
        }
    }
}

/// Transfer-Encoding: chunked の本文（SSE は終わりの無い chunked で届く）
pub struct Chunked {
    inner: BufReader<TcpStream>,
    left: usize,
    done: bool,
}

impl Read for Chunked {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.done || buf.is_empty() {
            return Ok(0);
        }
        if self.left == 0 {
            let mut line = String::new();
            // 前のチャンクの後ろの CRLF を読み飛ばす
            while line.trim().is_empty() {
                line.clear();
                if self.inner.read_line(&mut line)? == 0 {
                    return Err(io::ErrorKind::UnexpectedEof.into());
                }
            }
            let size = line.trim().split(';').next().unwrap_or("");
            let size = usize::from_str_radix(size, 16)
                .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "bad chunk size"))?;
            if size == 0 {
                self.done = true;
                return Ok(0);
            }
            self.left = size;
        }
        let max = self.left.min(buf.len());
        let n = self.inner.read(&mut buf[..max])?;
        if n == 0 {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        self.left -= n;
        Ok(n)
    }
}

/// 1回のリクエスト（本文はすべて読む）
pub fn request(
    port: u16,
    method: &str,
    path: &str,
    token: &str,
    body: Option<&str>,
) -> io::Result<Response> {
    let mut s = connect(port, Duration::from_secs(10))?;
    write_request(&mut s, port, method, path, token, body)?;
    let (status, mut b) = read_head(BufReader::new(s))?;
    let mut text = String::new();
    b.read_to_string(&mut text)?;
    Ok(Response { status, body: text })
}

/// 長く読み続けるリクエスト（SSE）。read_timeout の間に何も来なければ読み取りがエラーになる
pub fn open_stream(
    port: u16,
    path: &str,
    token: &str,
    read_timeout: Duration,
) -> io::Result<(u16, BufReader<Body>)> {
    let mut s = connect(port, read_timeout)?;
    write_request(&mut s, port, "GET", path, token, None)?;
    let (status, b) = read_head(BufReader::new(s))?;
    Ok((status, BufReader::new(b)))
}

/// URL のクエリに入れる値の符号化
pub fn encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// SSE の1イベント
#[derive(Debug, PartialEq)]
pub struct SseEvent {
    pub event: String,
    pub data: String,
}

/// SSE の行を1つ受け取り、イベントの区切り（空行）でイベントを返す
#[derive(Default)]
pub struct SseParser {
    event: String,
    data: Vec<String>,
}

impl SseParser {
    pub fn line(&mut self, line: &str) -> Option<SseEvent> {
        let line = line.trim_end_matches(['\r', '\n']);
        if line.is_empty() {
            if self.data.is_empty() && self.event.is_empty() {
                return None;
            }
            let ev = SseEvent {
                event: if self.event.is_empty() { "message".into() } else { std::mem::take(&mut self.event) },
                data: self.data.join("\n"),
            };
            self.data.clear();
            return Some(ev);
        }
        if line.starts_with(':') {
            return None;
        }
        let (k, v) = line.split_once(':').unwrap_or((line, ""));
        let v = v.strip_prefix(' ').unwrap_or(v);
        match k {
            "event" => self.event = v.to_string(),
            "data" => self.data.push(v.to_string()),
            _ => {}
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_sse_events() {
        let mut p = SseParser::default();
        let mut out = vec![];
        for l in ["event: hello\n", "data: {\"rev\":1}\n", "\n", ": comment\n", "data: a\n", "data: b\n", "\n"] {
            if let Some(e) = p.line(l) {
                out.push(e);
            }
        }
        assert_eq!(
            out,
            vec![
                SseEvent { event: "hello".into(), data: "{\"rev\":1}".into() },
                SseEvent { event: "message".into(), data: "a\nb".into() },
            ]
        );
    }

    #[test]
    fn encodes_query_values() {
        assert_eq!(encode("/queue?item=a b&x"), "/queue%3Fitem%3Da%20b%26x");
    }
}
