import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Transcript content locates a request. It never supplies the scopes shown for consent.
public struct PermissionRequest: Codable, Equatable, Sendable {
    public let requestID: String
    public let keyID: String

    public static func parse(_ value: JSON, depth: Int = 0) -> Self? {
        guard depth < 12 else { return nil }
        let value = ToolPresentation.decoded(value)
        if value["type"].string == "permission_request" {
            guard UUID(uuidString: value["request_id"].string) != nil,
                  value["key_id"].string.range(of: #"^[A-Za-z0-9_-]{12}$"#, options: .regularExpression) != nil,
                  ["pending", "approved", "denied", "expired"].contains(value["status"].string) else { return nil }
            return Self(requestID: value["request_id"].string.lowercased(), keyID: value["key_id"].string)
        }
        switch value {
        case .array(let values): return values.lazy.compactMap { parse($0, depth: depth + 1) }.first
        case .object(let fields):
            for key in ["content", "text", "structuredContent", "result", "output"] {
                if let child = fields[key], let request = parse(child, depth: depth + 1) { return request }
            }
            return nil
        default: return nil
        }
    }
}

public struct PermissionRequestReview: Equatable, Sendable {
    public struct Capability: Equatable, Sendable, Identifiable {
        public let id: String
        public let description: String
    }
    public let request: PermissionRequest
    public let status: String
    public let keyLabel: String
    public let reason: String
    public let capabilities: [Capability]
    public let expiresAt: Date
    public var isPending: Bool { status == "pending" && expiresAt > Date() }
    public var receipt: JSON {
        .object(["type": .string("permission_request_receipt"), "request_id": .string(request.requestID),
                 "key_id": .string(request.keyID), "status": .string(status)])
    }

    static func parse(_ value: JSON, request: PermissionRequest) throws -> Self {
        guard PermissionRequest.parse(value) == request,
              case .string(let label) = value["key_label"], label.utf8.count <= 1024,
              case .string(let reason) = value["reason"], !reason.isEmpty, reason.utf8.count <= 4096,
              case .number(let expiry) = value["expires_at"], expiry.isFinite, expiry > 0,
              case .object(let descriptions) = value["capability_descriptions"],
              case .array(let scopes) = value["capabilities"], (1...64).contains(scopes.count) else { throw APIError.invalidResponse }
        var capabilities: [Capability] = []
        for scope in scopes {
            guard case .string(let id) = scope, !id.isEmpty, id.utf8.count <= 128,
                  !capabilities.contains(where: { $0.id == id }),
                  case .string(let description) = descriptions[id] ?? .null, !description.isEmpty,
                  description.utf8.count <= 4096 else { throw APIError.invalidResponse }
            capabilities.append(.init(id: id, description: description))
        }
        return Self(request: request, status: value["status"].string, keyLabel: label, reason: reason,
                    capabilities: capabilities, expiresAt: Date(timeIntervalSince1970: expiry / 1000))
    }
}

extension ManagedClient {
    private func permissionRequestPath(_ request: PermissionRequest) throws -> String {
        // A transcript from another account/key cannot select a credential-bearing URL.
        guard UUID(uuidString: request.requestID) != nil,
              request.keyID == String(credential.apiKey.dropFirst("ncx_live_".count).prefix(12)) else { throw APIError.invalidCredential }
        return "/v1/permission-requests/" + request.keyID + "/" + request.requestID
    }

    public func permissionRequestApprovalURL(_ request: PermissionRequest) throws -> URL {
        _ = try permissionRequestPath(request)
        guard var url = URLComponents(string: credential.origin + "/") else { throw APIError.invalidResponse }
        url.queryItems = [URLQueryItem(name: "permission_request", value: request.requestID), URLQueryItem(name: "key_id", value: request.keyID)]
        guard let result = url.url else { throw APIError.invalidResponse }
        return result
    }

    private func permissionRequestJSON(_ request: PermissionRequest,
                                       configuration: URLSessionConfiguration) async throws -> JSON {
        let path = try permissionRequestPath(request)
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCredentialStorage = nil
        let session = URLSession(configuration: configuration, delegate: NoRedirects(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        var outgoing = try self.request(path: path)
        outgoing.cachePolicy = .reloadIgnoringLocalCacheData
        outgoing.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        outgoing.setValue(credential.origin, forHTTPHeaderField: "Origin")
        let (data, response) = try await session.data(for: outgoing)
        guard let response = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        guard (200..<300).contains(response.statusCode) else { throw APIError.http(response.statusCode) }
        guard data.count <= 64 * 1024 else { throw APIError.invalidResponse }
        return try JSONDecoder().decode(JSON.self, from: data)
    }

    public func permissionRequestReview(_ request: PermissionRequest, configuration: URLSessionConfiguration = .ephemeral) async throws -> PermissionRequestReview {
        let response = try await permissionRequestJSON(request, configuration: configuration)
        return try PermissionRequestReview.parse(response, request: request)
    }

}
