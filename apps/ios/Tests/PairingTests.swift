import XCTest
@testable import Atelier

@MainActor final class PairingTests: XCTestCase {
    /// What `pairingLink()` in packages/protocol writes for these inputs.
    private let link = "atelier://pair?token=\(String(repeating: "A", count: 43))&server=https%3A%2F%2Fatelier.example.com&server=http%3A%2F%2F192.168.1.20%3A7340"

    func testReadsALinkTheServerWrote() {
        let parsed = PairingLink.parse(link)
        XCTAssertEqual(parsed?.token, String(repeating: "A", count: 43))
        XCTAssertEqual(parsed?.addresses, ["https://atelier.example.com", "http://192.168.1.20:7340"])
        XCTAssertEqual(PairingLink.parse("  \(link)\n")?.addresses.count, 2)
    }

    func testRefusesAnythingThatIsNotAPairingLink() {
        XCTAssertNil(PairingLink.parse("https://atelier.example.com"))
        XCTAssertNil(PairingLink.parse("atelier://pair?token=short&server=https%3A%2F%2Fa.example"))
        XCTAssertNil(PairingLink.parse("atelier://pair?token=\(String(repeating: "A", count: 43))"))
        XCTAssertNil(PairingLink.parse("atelier://pair?token=\(String(repeating: "A", count: 43))&server=javascript%3Aalert(1)"))
        XCTAssertNil(PairingLink.parse("atelier://other?token=\(String(repeating: "A", count: 43))&server=https%3A%2F%2Fa.example"))
        XCTAssertNil(PairingLink.parse("hello"))
    }

    func testPlainHTTPIsAllowedOnlyOnTheOwnNetwork() throws {
        for address in ["https://atelier.example.com", "http://192.168.1.20:7340", "http://10.0.0.5:7340", "http://172.16.4.2:7340", "http://studio.local:7340", "http://localhost:7340", "http://127.0.0.1:7340"] {
            XCTAssertNoThrow(try serverURL(address), address)
        }
        for address in ["http://atelier.example.com", "http://8.8.8.8:7340", "http://172.32.0.1:7340", "http://192.169.1.1:7340", "ftp://192.168.1.20", "https://atelier.example.com/path", "http://user:pass@192.168.1.20"] {
            XCTAssertThrowsError(try serverURL(address), address)
        }
    }

    func testTellsPrivateHostsFromOthers() {
        XCTAssertTrue(LocalAddress.isPrivateHost("192.168.0.2"))
        XCTAssertTrue(LocalAddress.isPrivateHost("Mac-Studio.local"))
        XCTAssertFalse(LocalAddress.isPrivateHost("192.168.0"))
        XCTAssertFalse(LocalAddress.isPrivateHost("example.com"))
        XCTAssertFalse(LocalAddress.isPrivateHost("300.1.1.1"))
    }

    func testAnAddressOnTheNetworkWithoutHTTPSGetsAnExplanationOnlyWhenItIsNotPrivate() {
        XCTAssertNil(ChatSignIn.addressProblem("http://192.168.1.20:7340"))
        XCTAssertNotNil(ChatSignIn.addressProblem("http://atelier.example.com"))
        XCTAssertNil(ChatSignIn.addressProblem("192.168.1.20:7340"))
        XCTAssertEqual(ChatSignIn.normalized("192.168.1.20:7340"), "http://192.168.1.20:7340")
        XCTAssertEqual(ChatSignIn.normalized("studio.local/"), "http://studio.local")
        XCTAssertEqual(ChatSignIn.normalized("atelier.example.com"), "https://atelier.example.com")
    }
}
