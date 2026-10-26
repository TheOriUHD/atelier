import CoreGraphics
import XCTest

@testable import AtelierComputer

final class CaptureGeometryTests: XCTestCase {
  func testFitScalesDownKeepingTheAspectRatio() {
    // A 1800×1169-point Retina display: 3600×2338 pixels into 800×600.
    let size = CaptureGeometry.fit(width: 3600, height: 2338, maxWidth: 800, maxHeight: 600)
    XCTAssertEqual(size.width, 800)
    XCTAssertEqual(size.height, 520)
    // Height-bound.
    let tall = CaptureGeometry.fit(width: 1000, height: 4000, maxWidth: 800, maxHeight: 600)
    XCTAssertEqual(tall.width, 150)
    XCTAssertEqual(tall.height, 600)
  }

  func testFitNeverUpscales() {
    let size = CaptureGeometry.fit(width: 640, height: 480, maxWidth: 4000, maxHeight: 4000)
    XCTAssertEqual(size.width, 640)
    XCTAssertEqual(size.height, 480)
  }

  func testFitStaysInsideTheBox() {
    for (w, h) in [(3456.0, 2234.0), (5120, 2880), (1, 10000), (10000, 1), (2559, 1599)] {
      for (mw, mh) in [(1366, 768), (1024, 1024), (1, 1), (333, 777)] {
        let size = CaptureGeometry.fit(width: w, height: h, maxWidth: mw, maxHeight: mh)
        XCTAssertLessThanOrEqual(size.width, mw)
        XCTAssertLessThanOrEqual(size.height, mh)
        XCTAssertGreaterThanOrEqual(size.width, 1)
        XCTAssertGreaterThanOrEqual(size.height, 1)
        // Aspect ratio kept to within a pixel's rounding.
        if size.width > 20 && size.height > 20 {
          XCTAssertEqual(Double(size.width) / Double(size.height), w / h, accuracy: (w / h) * 0.05)
        }
      }
    }
  }

  func testCoveredRect() {
    let display = CGRect(x: 1800, y: -200, width: 2560, height: 1440)
    XCTAssertEqual(CaptureGeometry.coveredRect(region: nil, display: display), display)
    // Inside.
    let inside = CGRect(x: 2000, y: 0, width: 300, height: 200)
    XCTAssertEqual(CaptureGeometry.coveredRect(region: inside, display: display), inside)
    // Clipped to the display.
    XCTAssertEqual(
      CaptureGeometry.coveredRect(region: CGRect(x: 1700, y: -300, width: 300, height: 300), display: display),
      CGRect(x: 1800, y: -200, width: 200, height: 200))
    // Missing it.
    XCTAssertNil(CaptureGeometry.coveredRect(region: CGRect(x: 0, y: 0, width: 100, height: 100), display: display))
    // Touching edges only.
    XCTAssertNil(CaptureGeometry.coveredRect(region: CGRect(x: 1700, y: 0, width: 100, height: 100), display: display))
  }

  func testDisplayLocal() {
    let display = CGRect(x: -1440, y: -900, width: 1440, height: 900)
    XCTAssertEqual(
      CaptureGeometry.displayLocal(CGRect(x: -1000, y: -800, width: 100, height: 50), display: display),
      CGRect(x: 440, y: 100, width: 100, height: 50))
  }
}

final class ImageEncoderTests: XCTestCase {
  private func image(width: Int, height: Int) throws -> CGImage {
    let context = try XCTUnwrap(
      CGContext(
        data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue))
    context.setFillColor(red: 0.2, green: 0.5, blue: 0.8, alpha: 1)
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    return try XCTUnwrap(context.makeImage())
  }

  func testJPEG() throws {
    let data = try ImageEncoder.encode(image(width: 64, height: 32), format: .jpeg, quality: 0.8)
    XCTAssertEqual(Array(data.prefix(3)), [0xFF, 0xD8, 0xFF])
    let small = try ImageEncoder.encode(image(width: 64, height: 32), format: .jpeg, quality: 0.1)
    XCTAssertGreaterThan(small.count, 0)
  }

  func testPNG() throws {
    let data = try ImageEncoder.encode(image(width: 10, height: 10), format: .png, quality: 0.8)
    XCTAssertEqual(Array(data.prefix(8)), [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
  }

  func testMimeTypes() {
    XCTAssertEqual(ImageFormat.jpeg.mime, "image/jpeg")
    XCTAssertEqual(ImageFormat.png.mime, "image/png")
  }

  func testOwnAppsAreLeftOut() {
    XCTAssertTrue(Capture.isOwn("dev.atelier.app"))
    XCTAssertTrue(Capture.isOwn("dev.atelier.app.helper.Renderer"))
    XCTAssertFalse(Capture.isOwn("dev.atelier.application"))
    XCTAssertFalse(Capture.isOwn("com.apple.Safari"))
  }
}

final class BlankImageTests: XCTestCase {
  func testBlankIsBlackAndEncodes() throws {
    let image = try Capture.blank(width: 8, height: 4)
    XCTAssertEqual(image.width, 8)
    XCTAssertEqual(image.height, 4)
    let data = try ImageEncoder.encode(image, format: .png, quality: 1)
    XCTAssertEqual(Array(data.prefix(4)), [0x89, 0x50, 0x4E, 0x47])
    let bytes = try XCTUnwrap(image.dataProvider?.data as Data?)
    XCTAssertTrue(bytes.allSatisfy { $0 == 0 })
  }
}
