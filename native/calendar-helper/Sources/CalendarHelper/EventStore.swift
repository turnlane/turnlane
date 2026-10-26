import AppKit
import EventKit
import Foundation

/// デーモンへ返す形（phase0-plan 1.5 のプロトコル）。JSON にそのまま入れる辞書で持つ。
protocol CalendarStore: AnyObject {
  /// "fullAccess" | "denied" | "notDetermined" | "writeOnly"
  func authorization() -> String
  func listCalendars() -> [[String: Any]]
  func fetchEvents(calendarIds: [String], from: Date, to: Date) -> [[String: Any]]
  /// EKEventStoreChanged を受けたとき
  var onStoreChanged: (() -> Void)? { get set }
  /// EKEventStore を作り直す（権限が変わったとき。許可の前に作ったストアはカレンダーを返さないことがある。D-130）
  func reload()
  /// 予定を作る（0.4.0、D-093）。calendarId が nil なら、その時点の Calendar.app のデフォルトカレンダー。
  /// url は turnlane://event/ の目印。結果は fetchEvents の1件の形
  func createEvent(
    calendarId: String?, title: String, start: Date, end: Date, tz: String?, url: String
  ) throws -> [String: Any]
  /// 編集できる予定（editBlock が nil）だけを更新する。nil の項目は変えない。calendarId があればそのカレンダーへ移す
  func updateEvent(
    eventId: String, title: String?, start: Date?, end: Date?, calendarId: String?
  ) throws -> [String: Any]
  /// 編集できる予定だけを消す。見つからなければ false
  func removeEvent(eventId: String) throws -> Bool
  /// url が dayline://timeblock/ で始まる予定（M3-3 で書いた時間ブロック）。全カレンダー
  func listTimeblockEvents(from: Date, to: Date) -> [[String: Any]]
  /// url が dayline://timeblock/ で始まる予定だけを消す（それ以外は not_timeblock_event）。見つからなければ false
  func deleteTimeblockEvent(eventId: String) throws -> Bool
}

/// ストアの失敗（JSON-RPC のエラーにする。message は短い英字のコード）
struct StoreError: Error {
  let code: Int
  let message: String
}

func epochMs(_ d: Date) -> Double { (d.timeIntervalSince1970 * 1000).rounded() }

/// M3-3 で書いた時間ブロックの予定の目印（ADR 0003。D-093 で書くのをやめた。削除の対象の判定にだけ使う）
let timeblockUrlPrefix = "dayline://timeblock/"
/// Turnlane が作った予定の目印（ADR 0012、D-093）
let eventUrlPrefix = "turnlane://event/"

/// 時間ブロックの予定か: url が目印で始まるものだけ（url が無い予定・他の目印は含めない。D-093）
func isTimeblockEvent(url: String?) -> Bool {
  guard let url else { return false }
  return url.hasPrefix(timeblockUrlPrefix)
}

/// 予定の性質（編集できるかの判定に使う）
struct EventTraits {
  let calendarWritable: Bool
  let hasAttendees: Bool
  let recurring: Bool
  let allDay: Bool
  let url: String?
}

/// Turnlane から編集できない理由（編集できれば nil。ADR 0012 の Decision 3）。デーモンも同じ条件を見る
func editBlock(_ t: EventTraits) -> String? {
  if isTimeblockEvent(url: t.url) { return "timeblock" }
  if !t.calendarWritable { return "not_writable" }
  if t.hasAttendees { return "has_attendees" }
  if t.recurring { return "recurring" }
  if t.allDay { return "all_day" }
  return nil
}

/// 終日予定の日付（"YYYY-MM-DD"）。EventKit の終日予定は予定の日付の 0:00〜最終日の 23:59:59 なので、
/// 終わりは「最終日の翌日」（終わりを含まない）にそろえる
func dayString(_ d: Date, _ cal: Calendar) -> String {
  let c = cal.dateComponents([.year, .month, .day], from: d)
  return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
}

func allDayRange(start: Date, end: Date) -> (String, String) {
  let cal = Calendar.current
  let s = cal.startOfDay(for: start)
  var e = cal.startOfDay(for: end)
  if e <= s || end > e { e = cal.date(byAdding: .day, value: 1, to: e) ?? e }
  return (dayString(s, cal), dayString(e, cal))
}

final class EventKitStore: CalendarStore {
  private var store = EKEventStore()
  private var observer: NSObjectProtocol?
  var onStoreChanged: (() -> Void)?

  init() { observe() }

  private func observe() {
    if let observer { NotificationCenter.default.removeObserver(observer) }
    observer = NotificationCenter.default.addObserver(
      forName: .EKEventStoreChanged, object: store, queue: .main
    ) { [weak self] _ in
      self?.onStoreChanged?()
    }
  }

  func reload() {
    store = EKEventStore()
    observe()
  }

  static func authorizationString() -> String {
    switch EKEventStore.authorizationStatus(for: .event) {
    case .fullAccess: return "fullAccess"
    case .writeOnly: return "writeOnly"
    case .notDetermined: return "notDetermined"
    case .denied, .restricted: return "denied"
    @unknown default: return "denied"
    }
  }

  func authorization() -> String { EventKitStore.authorizationString() }

  /// 権限を求める（未決定ならダイアログが出る）。結果は authorizationString() で読み直す
  func requestFullAccess(_ done: @escaping (Bool, Error?) -> Void) {
    store.requestFullAccessToEvents { granted, error in
      DispatchQueue.main.async { done(granted, error) }
    }
  }

  func listCalendars() -> [[String: Any]] {
    // Calendar.app の 設定 > 一般 > デフォルトカレンダー（D-072）
    let def = store.defaultCalendarForNewEvents?.calendarIdentifier
    return store.calendars(for: .event).map { c in
      [
        "id": c.calendarIdentifier,
        "title": c.title,
        "sourceTitle": c.source?.title ?? NSNull(),
        "sourceType": sourceType(c.source?.sourceType),
        "colorHex": hex(c.cgColor) ?? NSNull(),
        "allowsModify": c.allowsContentModifications,
        "type": calendarType(c.type),
        "isDefault": c.calendarIdentifier == def,
      ]
    }
  }

  func fetchEvents(calendarIds: [String], from: Date, to: Date) -> [[String: Any]] {
    let wanted = Set(calendarIds)
    let cals = store.calendars(for: .event).filter { wanted.contains($0.calendarIdentifier) }
    if cals.isEmpty { return [] }
    let pred = store.predicateForEvents(withStart: from, end: to, calendars: cals)
    return store.events(matching: pred).map(eventDict)
  }

  /// 書き込み先のカレンダー（指定が無ければ Calendar.app のデフォルト。D-072）
  private func writableCalendar(_ calendarId: String?) throws -> EKCalendar {
    let cal: EKCalendar
    if let calendarId {
      guard let c = store.calendar(withIdentifier: calendarId) else {
        throw StoreError(code: 2, message: "calendar_not_found")
      }
      cal = c
    } else {
      guard let c = store.defaultCalendarForNewEvents else {
        throw StoreError(code: 7, message: "no_default_calendar")
      }
      cal = c
    }
    guard cal.allowsContentModifications else {
      throw StoreError(code: 3, message: "not_writable")
    }
    return cal
  }

  private func traits(_ e: EKEvent) -> EventTraits {
    EventTraits(
      calendarWritable: e.calendar?.allowsContentModifications == true,
      hasAttendees: !(e.attendees ?? []).isEmpty,
      recurring: e.hasRecurrenceRules,
      allDay: e.isAllDay,
      url: e.url?.absoluteString)
  }

  /// 編集できる予定を引く（見つからなければ nil。編集できなければ not_editable）
  private func editable(_ eventId: String) throws -> EKEvent? {
    guard let e = store.event(withIdentifier: eventId) else { return nil }
    if editBlock(traits(e)) != nil { throw StoreError(code: 9, message: "not_editable") }
    return e
  }

  private func save(_ e: EKEvent) throws {
    do {
      try store.save(e, span: .thisEvent, commit: true)
    } catch {
      throw StoreError(code: 4, message: "save_failed")
    }
  }

  func createEvent(
    calendarId: String?, title: String, start: Date, end: Date, tz: String?, url: String
  ) throws -> [String: Any] {
    let cal = try writableCalendar(calendarId)
    let event = EKEvent(eventStore: store)
    event.calendar = cal
    event.title = title
    event.startDate = start
    event.endDate = end
    event.isAllDay = false
    if let tz, let zone = TimeZone(identifier: tz) { event.timeZone = zone }
    event.url = URL(string: url)
    try save(event)
    return eventDict(event)
  }

  func updateEvent(
    eventId: String, title: String?, start: Date?, end: Date?, calendarId: String?
  ) throws -> [String: Any] {
    guard let event = try editable(eventId) else {
      throw StoreError(code: 8, message: "not_found")
    }
    if let calendarId, calendarId != event.calendar?.calendarIdentifier {
      event.calendar = try writableCalendar(calendarId)
    }
    if let title { event.title = title }
    let s = start ?? event.startDate ?? Date()
    let e = end ?? event.endDate ?? s
    guard e > s else { throw StoreError(code: 10, message: "invalid_range") }
    event.startDate = s
    event.endDate = e
    try save(event)
    return eventDict(event)
  }

  func removeEvent(eventId: String) throws -> Bool {
    guard let e = try editable(eventId) else { return false }
    do {
      try store.remove(e, span: .thisEvent, commit: true)
    } catch {
      throw StoreError(code: 4, message: "remove_failed")
    }
    return true
  }

  func listTimeblockEvents(from: Date, to: Date) -> [[String: Any]] {
    let pred = store.predicateForEvents(withStart: from, end: to, calendars: nil)
    var seen = Set<String>()
    var out: [[String: Any]] = []
    for e in store.events(matching: pred) where isTimeblockEvent(url: e.url?.absoluteString) {
      guard let id = e.eventIdentifier, !seen.contains(id) else { continue }
      seen.insert(id)
      out.append([
        "eventId": id,
        "calendarId": e.calendar?.calendarIdentifier ?? "",
        "start": epochMs(e.startDate ?? from),
        "end": epochMs(e.endDate ?? e.startDate ?? from),
      ])
    }
    return out
  }

  func deleteTimeblockEvent(eventId: String) throws -> Bool {
    guard let e = store.event(withIdentifier: eventId) else { return false }
    // 時間ブロックの予定（url の目印）だけを消す。Turnlane で作った予定・利用者の予定には触れない（D-093）
    guard isTimeblockEvent(url: e.url?.absoluteString) else {
      throw StoreError(code: 11, message: "not_timeblock_event")
    }
    do {
      try store.remove(e, span: .thisEvent, commit: true)
    } catch {
      throw StoreError(code: 4, message: "remove_failed")
    }
    return true
  }

  private func eventDict(_ e: EKEvent) -> [String: Any] {
    let start = e.startDate ?? Date(timeIntervalSince1970: 0)
    let end = e.endDate ?? start
    var d: [String: Any] = [
      "calendarId": e.calendar?.calendarIdentifier ?? "",
      "externalId": e.calendarItemExternalIdentifier ?? e.eventIdentifier ?? "",
      "eventId": e.eventIdentifier ?? NSNull(),
      "occurrenceStart": epochMs(e.occurrenceDate ?? start),
      "title": e.title ?? NSNull(),
      "location": e.location ?? NSNull(),
      "start": epochMs(start),
      "end": epochMs(end),
      "tz": e.timeZone?.identifier ?? NSNull(),
      "allDay": e.isAllDay,
      "status": status(e.status),
      "availability": availability(e.availability),
      "selfResponse": selfResponse(e),
      "url": e.url?.absoluteString ?? NSNull(),
      "conferenceUrl": NSNull(),
      "lastModified": e.lastModifiedDate.map(epochMs) ?? NSNull(),
      // 編集できるかの判定に使う（0.4.0、D-093）
      "hasAttendees": !(e.attendees ?? []).isEmpty,
      "recurring": e.hasRecurrenceRules,
      // 会議リンクがあるか（0.5.0、D-097）。メモの本文は返さない
      "hasMeetingLink": hasMeetingLink([e.url?.absoluteString, e.location, e.notes]),
    ]
    if e.isAllDay {
      let (s, en) = allDayRange(start: start, end: end)
      d["startDate"] = s
      d["endDate"] = en
    }
    return d
  }

  private func status(_ s: EKEventStatus) -> Any {
    switch s {
    case .confirmed: return "confirmed"
    case .tentative: return "tentative"
    case .canceled: return "cancelled"
    default: return NSNull()
    }
  }

  private func availability(_ a: EKEventAvailability) -> Any {
    switch a {
    case .busy: return "busy"
    case .free: return "free"
    case .tentative: return "tentative"
    case .unavailable: return "unavailable"
    default: return NSNull()
    }
  }

  private func selfResponse(_ e: EKEvent) -> Any {
    guard let me = e.attendees?.first(where: { $0.isCurrentUser }) else { return NSNull() }
    switch me.participantStatus {
    case .accepted: return "accepted"
    case .declined: return "declined"
    case .tentative: return "tentative"
    case .pending: return "pending"
    default: return "unknown"
    }
  }

  private func calendarType(_ t: EKCalendarType) -> String {
    switch t {
    case .local: return "local"
    case .calDAV: return "calDAV"
    case .exchange: return "exchange"
    case .subscription: return "subscription"
    case .birthday: return "birthday"
    @unknown default: return "unknown"
    }
  }

  private func sourceType(_ t: EKSourceType?) -> Any {
    guard let t else { return NSNull() }
    switch t {
    case .local: return "local"
    case .exchange: return "exchange"
    case .calDAV: return "calDAV"
    case .mobileMe: return "mobileMe"
    case .subscribed: return "subscribed"
    case .birthdays: return "birthdays"
    @unknown default: return "unknown"
    }
  }

  private func hex(_ c: CGColor?) -> String? {
    guard let c, let ns = NSColor(cgColor: c)?.usingColorSpace(.sRGB) else { return nil }
    let r = Int((ns.redComponent * 255).rounded())
    let g = Int((ns.greenComponent * 255).rounded())
    let b = Int((ns.blueComponent * 255).rounded())
    return String(format: "#%02x%02x%02x", r, g, b)
  }
}

/// EventKit を使わない固定のダミー（--fake-store）。題名はすべて架空。
/// 自動の確認（scripts/check-calendar-helper.ts）で、TCC に触れずにプロトコルを通すために使う
final class FakeStore: CalendarStore {
  var onStoreChanged: (() -> Void)?
  /// 権限（--fake-auth-file。起動時の値のまま。D-130 の確かめ用）
  private let auth: String
  private(set) var reloads = 0
  /// 作った予定と、時間ブロックの予定（メモリだけ）
  private var written: [String: [String: Any]] = [:]
  private var seq = 0

  /// デフォルトカレンダー（Work。D-072）
  private let defaultCalendarId = "fake-work"

  /// カレンダーが 1 つも無い Mac（--fake-empty。2026-10-21 の Neo: アカウントの無い Mac で許可した後）
  private let empty: Bool

  init(authorization: String = "fullAccess", empty: Bool = false) {
    auth = authorization
    self.empty = empty
    if empty { return }
    // M3-3 で書いた時間ブロックの予定（削除の対象）と、Turnlane で作った予定（対象外）
    let today = Calendar.current.startOfDay(for: Date())
    let s = today.addingTimeInterval(16 * 3600)
    written["fake-tb-1"] = fakeEvent(
      id: "fake-tb-1", calendarId: "fake-work", title: "Old time block", start: s,
      end: s.addingTimeInterval(1800), url: "\(timeblockUrlPrefix)block-1", hasAttendees: false)
    written["fake-own-1"] = fakeEvent(
      id: "fake-own-1", calendarId: "fake-work", title: "Made in Turnlane",
      start: s.addingTimeInterval(3600), end: s.addingTimeInterval(5400),
      url: "\(eventUrlPrefix)own-1", hasAttendees: false)
  }

  private func fakeEvent(
    id: String, calendarId: String, title: String, start: Date, end: Date, url: String?,
    hasAttendees: Bool
  ) -> [String: Any] {
    [
      "calendarId": calendarId, "externalId": "uid-\(id)", "eventId": id,
      "occurrenceStart": epochMs(start), "title": title, "location": NSNull(),
      "start": epochMs(start), "end": epochMs(end), "tz": TimeZone.current.identifier,
      "allDay": false, "status": "confirmed", "availability": "busy",
      "selfResponse": NSNull(), "url": url ?? NSNull(), "conferenceUrl": NSNull(),
      "lastModified": epochMs(Date()), "hasAttendees": hasAttendees, "recurring": false,
      "hasMeetingLink": false,
    ]
  }

  private func traits(_ e: [String: Any]) -> EventTraits {
    EventTraits(
      calendarWritable: (e["calendarId"] as? String) == "fake-work",
      hasAttendees: (e["hasAttendees"] as? Bool) ?? true,
      recurring: (e["recurring"] as? Bool) ?? false,
      allDay: (e["allDay"] as? Bool) ?? false,
      url: e["url"] as? String)
  }

  /// 利用者の会議（Weekly sync。参加者あり）は fetchEvents の固定の予定。written に無いものは見つからない扱い
  private func find(_ eventId: String) throws -> [String: Any]? {
    if eventId == "fake-sync-1" { throw StoreError(code: 9, message: "not_editable") }
    return written[eventId]
  }

  func createEvent(
    calendarId: String?, title: String, start: Date, end: Date, tz: String?, url: String
  ) throws -> [String: Any] {
    guard (calendarId ?? defaultCalendarId) == "fake-work" else {
      throw StoreError(code: 3, message: "not_writable")
    }
    seq += 1
    let id = "fake-created-\(seq)"
    let e = fakeEvent(
      id: id, calendarId: "fake-work", title: title, start: start, end: end, url: url,
      hasAttendees: false)
    written[id] = e
    return e
  }

  func updateEvent(
    eventId: String, title: String?, start: Date?, end: Date?, calendarId: String?
  ) throws -> [String: Any] {
    guard var e = try find(eventId) else { throw StoreError(code: 8, message: "not_found") }
    if editBlock(traits(e)) != nil { throw StoreError(code: 9, message: "not_editable") }
    if let calendarId, calendarId != "fake-work" {
      throw StoreError(code: 3, message: "not_writable")
    }
    if let title { e["title"] = title }
    if let start {
      e["start"] = epochMs(start)
      e["occurrenceStart"] = epochMs(start)
    }
    if let end { e["end"] = epochMs(end) }
    e["lastModified"] = epochMs(Date())
    written[eventId] = e
    return e
  }

  func removeEvent(eventId: String) throws -> Bool {
    guard let e = try find(eventId) else { return false }
    if editBlock(traits(e)) != nil { throw StoreError(code: 9, message: "not_editable") }
    return written.removeValue(forKey: eventId) != nil
  }

  func listTimeblockEvents(from: Date, to: Date) -> [[String: Any]] {
    written.values
      .filter { isTimeblockEvent(url: $0["url"] as? String) }
      .map { e in
        [
          "eventId": e["eventId"] ?? "", "calendarId": e["calendarId"] ?? "",
          "start": e["start"] ?? 0, "end": e["end"] ?? 0,
        ]
      }
  }

  func deleteTimeblockEvent(eventId: String) throws -> Bool {
    if eventId == "fake-sync-1" { throw StoreError(code: 11, message: "not_timeblock_event") }
    guard let e = written[eventId] else { return false }
    guard isTimeblockEvent(url: e["url"] as? String) else {
      throw StoreError(code: 11, message: "not_timeblock_event")
    }
    written.removeValue(forKey: eventId)
    return true
  }

  func authorization() -> String { auth }

  func reload() { reloads += 1 }

  func listCalendars() -> [[String: Any]] {
    if empty { return [] }
    return [
      [
        "id": "fake-work", "title": "Work", "sourceTitle": "Example", "sourceType": "calDAV",
        "colorHex": "#6b8cc7", "allowsModify": true, "type": "calDAV", "isDefault": true,
      ],
      [
        "id": "fake-holidays", "title": "Holidays", "sourceTitle": "Other",
        "sourceType": "subscribed", "colorHex": "#4fb3a9", "allowsModify": false,
        "type": "subscription", "isDefault": false,
      ],
    ]
  }

  func fetchEvents(calendarIds: [String], from: Date, to: Date) -> [[String: Any]] {
    if empty { return [] }
    let cal = Calendar.current
    let today = cal.startOfDay(for: Date())
    var out: [[String: Any]] = []
    if calendarIds.contains("fake-work") {
      let s = cal.date(byAdding: .hour, value: 10, to: today) ?? today
      let e = cal.date(byAdding: .minute, value: 45, to: s) ?? s
      out.append([
        "calendarId": "fake-work", "externalId": "fake-sync", "eventId": "fake-sync-1",
        "occurrenceStart": epochMs(s), "title": "Weekly sync",
        "location": "https://meet.google.com/aaa-bbbb-ccc",
        "start": epochMs(s), "end": epochMs(e), "tz": TimeZone.current.identifier,
        "allDay": false, "status": "confirmed", "availability": "busy",
        "selfResponse": "accepted", "url": NSNull(), "conferenceUrl": NSNull(),
        "lastModified": epochMs(today), "hasAttendees": true, "recurring": false,
        "hasMeetingLink": hasMeetingLink(["https://meet.google.com/aaa-bbbb-ccc"]),
      ])
    }
    if calendarIds.contains("fake-holidays") {
      let d = cal.date(byAdding: .day, value: 3, to: today) ?? today
      let next = cal.date(byAdding: .day, value: 1, to: d) ?? d
      out.append([
        "calendarId": "fake-holidays", "externalId": "fake-holiday", "eventId": "fake-holiday-1",
        "occurrenceStart": epochMs(d), "title": "Example Day", "location": NSNull(),
        "start": epochMs(d), "end": epochMs(next.addingTimeInterval(-1)), "tz": NSNull(),
        "allDay": true, "startDate": dayString(d, cal), "endDate": dayString(next, cal),
        "status": "confirmed", "availability": "free", "selfResponse": NSNull(),
        "url": NSNull(), "conferenceUrl": NSNull(), "lastModified": epochMs(today),
        "hasAttendees": false, "recurring": false, "hasMeetingLink": false,
      ])
    }
    out.append(contentsOf: written.values)
    return out.filter { ($0["calendarId"] as? String).map(calendarIds.contains) ?? false }
  }
}
