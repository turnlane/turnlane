import Foundation

/// デーモンへの WebSocket クライアント（phase0-plan 1.5）。
/// - ws://127.0.0.1:<port>/internal/ek に Authorization: Bearer <token> で接続する
/// - デーモンからの JSON-RPC 2.0 の要求（status / listCalendars / fetchEvents / createEvent / updateEvent /
///   removeEvent / listTimeblockEvents / deleteTimeblockEvent。0.4.0、D-093）に応える
/// - EKEventStoreChanged と権限の変化を通知（storeChanged / authorizationChanged）で送る。権限は 30 秒ごと・storeChanged・
///   status の要求のたびに確かめ直し、変われば EKEventStore を作り直す。プロセスの中の値が古ければ起動し直す（D-130）
/// - 切れたら指数バックオフ（1s → 30s）で接続し直す。トークンは接続のたびに読み直す
final class Bridge: NSObject, URLSessionWebSocketDelegate {
  private let config: HelperConfig
  private let store: CalendarStore
  private var session: URLSession!
  private var task: URLSessionWebSocketTask?
  private var backoff: TimeInterval = 1
  private var connected = false
  private let monitor: AuthorizationMonitor
  /// このプロセスの中の権限が古いと分かった（D-130。起動し直す）
  private let onStale: (String) -> Void

  init(
    config: HelperConfig, store: CalendarStore, monitor: AuthorizationMonitor,
    onStale: @escaping (String) -> Void
  ) {
    self.config = config
    self.store = store
    self.monitor = monitor
    self.onStale = onStale
    super.init()
    session = URLSession(configuration: .default, delegate: self, delegateQueue: .main)
    store.onStoreChanged = { [weak self] in
      self?.checkAuthorization()
      self?.notify("storeChanged")
    }
    // 権限はシステム設定で後から変わりうる。変化はイベントで来ないので 30 秒ごとに見る
    Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
      self?.checkAuthorization()
    }
  }

  func start() { connect() }

  private func connect() {
    guard let url = URL(string: "ws://127.0.0.1:\(config.port)/internal/ek") else { return }
    var req = URLRequest(url: url)
    let token = (try? String(contentsOfFile: config.tokenPath, encoding: .utf8))?
      .trimmingCharacters(in: .whitespacesAndNewlines)
    if let token, !token.isEmpty {
      req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    }
    req.setValue("turnlane-calendar-helper/\(HelperInfo.version)", forHTTPHeaderField: "User-Agent")
    let t = session.webSocketTask(with: req)
    task = t
    t.resume()
    receive(t)
  }

  private func scheduleReconnect() {
    let delay = backoff
    backoff = min(backoff * 2, 30)
    DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in self?.connect() }
  }

  private func receive(_ t: URLSessionWebSocketTask) {
    t.receive { [weak self] result in
      guard let self, t === self.task else { return }
      switch result {
      case .success(.string(let text)):
        self.handle(text)
        self.receive(t)
      case .success(.data(let data)):
        self.handle(String(decoding: data, as: UTF8.self))
        self.receive(t)
      case .success:
        self.receive(t)
      case .failure:
        self.dropped(t)
      }
    }
  }

  private func dropped(_ t: URLSessionWebSocketTask) {
    guard t === task else { return }
    task = nil
    if connected { log("bridge.disconnected", [:]) }
    connected = false
    t.cancel(with: .goingAway, reason: nil)
    scheduleReconnect()
  }

  // MARK: URLSessionWebSocketDelegate

  func urlSession(
    _ session: URLSession, webSocketTask: URLSessionWebSocketTask,
    didOpenWithProtocol protocol: String?
  ) {
    guard webSocketTask === task else { return }
    connected = true
    backoff = 1
    log("bridge.connected", ["port": config.port, "authorization": store.authorization()])
  }

  func urlSession(
    _ session: URLSession, webSocketTask: URLSessionWebSocketTask,
    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?
  ) {
    dropped(webSocketTask)
  }

  func urlSession(_ session: URLSession, task t: URLSessionTask, didCompleteWithError error: Error?)
  {
    if let ws = t as? URLSessionWebSocketTask, ws === task {
      if !connected { log("bridge.connect_failed", ["port": config.port]) }
      dropped(ws)
    }
  }

  // MARK: JSON-RPC

  private func handle(_ text: String) {
    guard
      let obj = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any],
      let method = obj["method"] as? String
    else { return }
    let id = obj["id"]
    let params = obj["params"] as? [String: Any] ?? [:]
    // 通知（id なし）はデーモンからは来ない。来ても無視する
    guard let id, !(id is NSNull) else { return }
    do {
      let result = try dispatch(method, params)
      send(["jsonrpc": "2.0", "id": id, "result": result])
    } catch let e as RpcError {
      send(["jsonrpc": "2.0", "id": id, "error": ["code": e.code, "message": e.message]])
    } catch {
      send(["jsonrpc": "2.0", "id": id, "error": ["code": -32603, "message": "internal error"]])
    }
  }

  private func dispatch(_ method: String, _ params: [String: Any]) throws -> Any {
    switch method {
    case "status":
      // 同期のたびに権限を確かめ直す（D-130。古ければ応答の後に起動し直す）
      checkAuthorization()
      return ["authorization": store.authorization(), "version": HelperInfo.version]
    case "listCalendars":
      try requireAccess()
      return store.listCalendars()
    case "fetchEvents":
      try requireAccess()
      guard
        let ids = params["calendarIds"] as? [String],
        let from = (params["from"] as? NSNumber)?.doubleValue,
        let to = (params["to"] as? NSNumber)?.doubleValue, to > from
      else { throw RpcError(code: -32602, message: "invalid params") }
      return store.fetchEvents(
        calendarIds: ids,
        from: Date(timeIntervalSince1970: from / 1000),
        to: Date(timeIntervalSince1970: to / 1000))
    case "createEvent":
      try requireAccess()
      // calendarId を省けば Calendar.app のデフォルトカレンダー（D-072）。目印は turnlane://event/（D-093）
      let calendarId = params["calendarId"] as? String
      guard
        calendarId == nil || calendarId?.isEmpty == false,
        let title = params["title"] as? String,
        let start = (params["start"] as? NSNumber)?.doubleValue,
        let end = (params["end"] as? NSNumber)?.doubleValue, end > start,
        let url = params["url"] as? String, url.hasPrefix(eventUrlPrefix)
      else { throw RpcError(code: -32602, message: "invalid params") }
      let r = try storeCall {
        try store.createEvent(
          calendarId: calendarId, title: title, start: Date(timeIntervalSince1970: start / 1000),
          end: Date(timeIntervalSince1970: end / 1000), tz: params["tz"] as? String, url: url)
      }
      // 題名は記録しない（件数とコードだけ）
      log("event.create", ["default": calendarId == nil])
      return r
    case "updateEvent":
      try requireAccess()
      guard let eventId = params["eventId"] as? String, !eventId.isEmpty else {
        throw RpcError(code: -32602, message: "invalid params")
      }
      let calendarId = params["calendarId"] as? String
      let start = (params["start"] as? NSNumber)?.doubleValue
      let end = (params["end"] as? NSNumber)?.doubleValue
      guard calendarId == nil || calendarId?.isEmpty == false else {
        throw RpcError(code: -32602, message: "invalid params")
      }
      let r = try storeCall {
        try store.updateEvent(
          eventId: eventId, title: params["title"] as? String,
          start: start.map { Date(timeIntervalSince1970: $0 / 1000) },
          end: end.map { Date(timeIntervalSince1970: $0 / 1000) }, calendarId: calendarId)
      }
      log("event.update", ["moved_calendar": calendarId != nil])
      return r
    case "removeEvent":
      try requireAccess()
      guard let eventId = params["eventId"] as? String, !eventId.isEmpty else {
        throw RpcError(code: -32602, message: "invalid params")
      }
      let deleted = try storeCall { try store.removeEvent(eventId: eventId) }
      log("event.remove", ["deleted": deleted])
      return ["deleted": deleted]
    case "listTimeblockEvents":
      try requireAccess()
      guard
        let from = (params["from"] as? NSNumber)?.doubleValue,
        let to = (params["to"] as? NSNumber)?.doubleValue, to > from
      else { throw RpcError(code: -32602, message: "invalid params") }
      let r = store.listTimeblockEvents(
        from: Date(timeIntervalSince1970: from / 1000), to: Date(timeIntervalSince1970: to / 1000))
      log("timeblock.list", ["count": r.count])
      return r
    case "deleteTimeblockEvent":
      try requireAccess()
      guard let eventId = params["eventId"] as? String, !eventId.isEmpty else {
        throw RpcError(code: -32602, message: "invalid params")
      }
      let deleted = try storeCall { try store.deleteTimeblockEvent(eventId: eventId) }
      log("timeblock.delete", ["deleted": deleted])
      return ["deleted": deleted]
    default:
      throw RpcError(code: -32601, message: "method not found")
    }
  }

  /// ストアの失敗を JSON-RPC のエラーにする
  private func storeCall<T>(_ f: () throws -> T) throws -> T {
    do {
      return try f()
    } catch let e as StoreError {
      throw RpcError(code: e.code, message: e.message)
    }
  }

  private func requireAccess() throws {
    if store.authorization() != "fullAccess" {
      throw RpcError(code: 1, message: "no full access")
    }
  }

  private func notify(_ method: String, _ params: [String: Any]? = nil) {
    var m: [String: Any] = ["jsonrpc": "2.0", "method": method]
    if let params { m["params"] = params }
    send(m)
  }

  /// 権限を確かめ直す（30秒ごと・storeChanged・status）。変わっていれば EKEventStore を作り直して知らせる。
  /// このプロセスの中の値が古ければ（別のプロセスでは違う値）起動し直す（D-130）
  private func checkAuthorization() {
    switch monitor.check() {
    case .unchanged: break
    case .changed(let a):
      store.reload()
      log("authorization.changed", ["authorization": a])
      notify("authorizationChanged", ["authorization": a])
    case .stale(let fresh):
      log("authorization.stale", ["in_process": monitor.last, "fresh": fresh])
      onStale(fresh)
    }
  }

  private func send(_ obj: [String: Any]) {
    guard connected, let t = task,
      let data = try? JSONSerialization.data(withJSONObject: obj),
      let text = String(data: data, encoding: .utf8)
    else { return }
    t.send(.string(text)) { _ in }
  }
}

struct RpcError: Error {
  let code: Int
  let message: String
}
