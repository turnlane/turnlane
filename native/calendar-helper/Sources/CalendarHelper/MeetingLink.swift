import Foundation

/// 会議リンクの判定（0.5.0、D-097）。予定の URL・場所・メモに会議サービスの URL があるか。
/// メモの本文はヘルパの外に出さず、真偽値だけを返す（ADR 0005 と同じ考え方）。
/// 一覧はデーモンの packages/core/src/focus/meeting-link.ts の MEETING_HOSTS と同じにする（テストで照合する）。
/// 先頭が "." のものはそのドメインのサブドメインも含む。
let meetingHosts: [String] = [
  "meet.google.com",
  "zoom.us",
  ".zoom.us",
  "zoomgov.com",
  ".zoomgov.com",
  "teams.microsoft.com",
  "teams.live.com",
  ".webex.com",
  "whereby.com",
  "meet.jit.si",
  "chime.aws",
  "bluejeans.com",
  ".bluejeans.com",
  "gotomeeting.com",
  ".gotomeeting.com",
  "meet.goto.com",
  "around.co",
  "facetime.apple.com",
]

func isMeetingHost(_ host: String) -> Bool {
  var h = host.lowercased()
  if h.hasSuffix(".") { h.removeLast() }
  return meetingHosts.contains { m in m.hasPrefix(".") ? h.hasSuffix(m) : h == m }
}

private let urlPattern = try? NSRegularExpression(
  pattern: "https?://([a-z0-9.-]+)", options: [.caseInsensitive])

/// 文字列のどれかに会議サービスの URL があるか（nil・空は飛ばす）
func hasMeetingLink(_ texts: [String?]) -> Bool {
  guard let re = urlPattern else { return false }
  for case let t? in texts where !t.isEmpty {
    let ns = t as NSString
    for m in re.matches(in: t, range: NSRange(location: 0, length: ns.length)) where m.numberOfRanges > 1 {
      if isMeetingHost(ns.substring(with: m.range(at: 1))) { return true }
    }
  }
  return false
}
