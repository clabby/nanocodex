import Foundation
import CryptoKit
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// In-memory, account-separated authority for finite managed Agent requests.
/// The server binds each short-lived token to the original account credential.
public enum ManagedAccess {
    private final class Entry {
        let token: String
        let until: TimeInterval
        init(token: String, until: TimeInterval) { self.token = token; self.until = until }
    }
    private static let header = "x-nanocodex-access"
    private static let lock = NSLock()
    private static let entries: NSCache<NSString, Entry> = {
        let cache = NSCache<NSString, Entry>(); cache.countLimit = 64; return cache
    }()

    private static func identity(_ request: URLRequest) -> NSString? {
        guard let url = request.url, url.scheme == "https", let host = url.host,
              url.path == "/v1/agents" || url.path.hasPrefix("/v1/agents/"),
              !["ws", "events", "tool-host", "device-host", "sideband"].contains(url.lastPathComponent),
              request.value(forHTTPHeaderField: "Upgrade") == nil,
              request.value(forHTTPHeaderField: "Accept")?.contains("text/event-stream") != true,
              let authorization = request.value(forHTTPHeaderField: "Authorization"), authorization.hasPrefix("Bearer ncx_live_") else { return nil }
        let scope = "https://\(host):\(url.port ?? 443)\n\(authorization)"
        return SHA256.hash(data: Data(scope.utf8)).map { String(format: "%02x", $0) }.joined() as NSString
    }

    public static func clear() { lock.lock(); defer { lock.unlock() }; entries.removeAllObjects() }

    public static func data(for original: URLRequest, using session: URLSession) async throws -> (Data, URLResponse) {
        guard let identity = identity(original) else { return try await session.data(for: original) }
        let began = ProcessInfo.processInfo.systemUptime
        let token: String? = cachedToken(identity, now: began)
        var request = original
        request.setValue(token, forHTTPHeaderField: header)
        var result = try await session.data(for: request)
        if token != nil, let rejected = result.1 as? HTTPURLResponse, rejected.statusCode == 401,
           rejected.value(forHTTPHeaderField: "x-nanocodex-access-rejected") == "1" {
            invalidate(identity, token: token!)
            request.setValue(nil, forHTTPHeaderField: header)
            // Ingress rejected the snapshot before admission. Retry the same operation once.
            result = try await session.data(for: request)
        }
        if let response = result.1 as? HTTPURLResponse { remember(identity, response: response, began: began) }
        return result
    }

    private static func cachedToken(_ identity: NSString, now: TimeInterval) -> String? {
        lock.lock(); defer { lock.unlock() }
        guard let value = entries.object(forKey: identity), value.until > now + 5 else { return nil }
        return value.token
    }
    private static func invalidate(_ identity: NSString, token: String) {
        lock.lock(); defer { lock.unlock() }
        if entries.object(forKey: identity)?.token == token { entries.removeObject(forKey: identity) }
    }
    private static func remember(_ identity: NSString, response: HTTPURLResponse, began: TimeInterval) {
        guard (200..<300).contains(response.statusCode), let token = response.value(forHTTPHeaderField: header),
              token.hasPrefix("ncx_access_v1."), token.utf8.count <= 16_384,
              let ttl = Double(response.value(forHTTPHeaderField: "x-nanocodex-access-ttl-ms") ?? ""),
              ttl.isFinite, ttl > 0, ttl <= 120_000 else { return }
        let until = began + ttl / 1000
        lock.lock(); defer { lock.unlock() }
        if let current = entries.object(forKey: identity), current.until >= until { return }
        entries.setObject(Entry(token: token, until: until), forKey: identity)
    }
}
