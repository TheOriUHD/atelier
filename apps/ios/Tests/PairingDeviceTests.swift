import XCTest
@testable import Atelier

@MainActor final class PairingDeviceTests: XCTestCase {
    func testModelsAreNamedByTheirHardwareIdentifier() {
        XCTAssertEqual(PairingDevice.modelName(identifier: "iPhone18,1", idiom: .phone), "iPhone 17 Pro")
        XCTAssertEqual(PairingDevice.modelName(identifier: "iPad17,3", idiom: .pad), "iPad Pro 13-inch (M5)")
        XCTAssertEqual(PairingDevice.modelName(identifier: "iPhone17,1", idiom: .phone), "iPhone 16 Pro")
    }

    func testAnUnknownModelSaysOnlyWhatKindItIs() {
        XCTAssertEqual(PairingDevice.modelName(identifier: "iPhone99,9", idiom: .phone), "iPhone")
        XCTAssertEqual(PairingDevice.modelName(identifier: "iPad99,9", idiom: .pad), "iPad")
        XCTAssertEqual(PairingDevice.modelName(identifier: "arm64", idiom: .phone), "iPhone")
    }

    func testTheAppVersionComesFromTheBundleAndTheDeviceJSONCarriesAllThree() {
        XCTAssertFalse(PairingDevice.appVersion().isEmpty)
        let json = PairingDevice.json
        XCTAssertFalse(json["model"].string.isEmpty)
        XCTAssertEqual(json["appVersion"].string, PairingDevice.appVersion())
        XCTAssertNotNil(json["name"].stringOrNil)
    }

    func testATelephotoLensIsNamedByHowMuchNarrowerItSees() {
        // Fields of view of a main camera and of a 2x, a 3x and a 5x lens.
        XCTAssertEqual(ScannerLens.telephotoFactor(wideFieldOfView: 69, telephotoFieldOfView: 36), 2)
        XCTAssertEqual(ScannerLens.telephotoFactor(wideFieldOfView: 69, telephotoFieldOfView: 24), 3)
        XCTAssertEqual(ScannerLens.telephotoFactor(wideFieldOfView: 69, telephotoFieldOfView: 15), 5)
        XCTAssertEqual(ScannerLens.telephotoFactor(wideFieldOfView: 0, telephotoFieldOfView: 20), 2, "no main camera to compare with")
    }

    func testThePickerIsEmptyOrNotByWhatThePhoneHas() {
        // The controls offer lenses only when there is more than one; the scanner leaves the list empty otherwise.
        let controls = ScannerControls()
        XCTAssertTrue(controls.lenses.isEmpty)
        XCTAssertFalse(controls.torchAvailable)
        XCTAssertFalse(controls.torchOn, "the flashlight is never on by itself")
    }
}
