import AppKit
import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

/// The arithmetic of a screenshot: which part of the display, and how many pixels.
public enum CaptureGeometry {
  /// The part of the display a capture covers, in global points: the region clipped to the display, or the whole
  /// display. nil when the region misses the display.
  public static func coveredRect(region: CGRect?, display: CGRect) -> CGRect? {
    guard let region else { return display }
    let clipped = region.standardized.intersection(display)
    guard !clipped.isNull, clipped.width > 0, clipped.height > 0 else { return nil }
    return clipped
  }

  /// A global rectangle in the display's own points (its top-left at 0,0), as `SCStreamConfiguration.sourceRect`
  /// takes it.
  public static func displayLocal(_ rect: CGRect, display: CGRect) -> CGRect {
    rect.offsetBy(dx: -display.minX, dy: -display.minY)
  }

  /// The image size for a source of `width`×`height` pixels: scaled down, keeping the aspect ratio, to fit
  /// `maxWidth`×`maxHeight`, and never scaled up.
  public static func fit(width: Double, height: Double, maxWidth: Int, maxHeight: Int) -> (width: Int, height: Int) {
    guard width > 0, height > 0, maxWidth > 0, maxHeight > 0 else { return (1, 1) }
    let factor = min(1, Double(maxWidth) / width, Double(maxHeight) / height)
    let w = min(maxWidth, max(1, Int((width * factor).rounded())))
    let h = min(maxHeight, max(1, Int((height * factor).rounded())))
    return (w, h)
  }
}

public enum ImageEncoder {
  public static func encode(_ image: CGImage, format: ImageFormat, quality: Double) throws -> Data {
    let data = NSMutableData()
    let type = (format == .png ? UTType.png : UTType.jpeg).identifier as CFString
    guard let destination = CGImageDestinationCreateWithData(data as CFMutableData, type, 1, nil) else {
      throw RPCError.internal("could not create the \(format.rawValue) encoder")
    }
    var properties: [CFString: Any] = [:]
    if format == .jpeg { properties[kCGImageDestinationLossyCompressionQuality] = quality }
    CGImageDestinationAddImage(destination, image, properties as CFDictionary)
    guard CGImageDestinationFinalize(destination) else {
      throw RPCError.internal("could not encode the screenshot as \(format.rawValue)")
    }
    return data as Data
  }
}

enum Capture {
  /// Bundle ids whose windows a full-display screenshot leaves out: Atelier, and the app that started the helper
  /// (the Electron app in development) when it is one.
  static let ownBundleIDs: [String] = {
    var ids = ["dev.atelier.app"]
    if let parent = NSRunningApplication(processIdentifier: getppid())?.bundleIdentifier, !ids.contains(parent) {
      ids.append(parent)
    }
    return ids
  }()

  static func isOwn(_ bundleID: String) -> Bool {
    ownBundleIDs.contains { bundleID == $0 || bundleID.hasPrefix($0 + ".") }
  }

  static func display(_ params: CaptureDisplayParams) async throws -> CaptureResult {
    guard params.maxWidth.isFinite, params.maxHeight.isFinite, params.maxWidth >= 1, params.maxHeight >= 1,
      params.maxWidth <= 16384, params.maxHeight <= 16384
    else { throw RPCError.invalidParams("maxWidth and maxHeight must be between 1 and 16384") }
    let quality = params.quality ?? 0.8
    guard quality.isFinite, (0...1).contains(quality) else { throw RPCError.invalidParams("quality must be 0–1") }
    if let region = params.region {
      guard [region.x, region.y, region.width, region.height].allSatisfy(\.isFinite), region.width > 0,
        region.height > 0
      else { throw RPCError.invalidParams("region must have a positive width and height") }
    }
    guard let displayID = CGDirectDisplayID(params.display), Displays.isActive(displayID) else {
      throw RPCError.notFound("no display \(params.display)")
    }
    let bounds = CGDisplayBounds(displayID)
    guard let covered = CaptureGeometry.coveredRect(region: params.region?.cgRect, display: bounds) else {
      throw RPCError.invalidParams("region is outside display \(params.display)")
    }
    guard CGPreflightScreenCaptureAccess() else { throw RPCError.permission(.screenRecording) }

    let content: SCShareableContent
    do {
      content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    } catch {
      throw mapError(error)
    }
    guard let display = content.displays.first(where: { $0.displayID == displayID }) else {
      throw RPCError.notFound("no display \(params.display)")
    }

    let filter: SCContentFilter
    if let apps = params.apps {
      // Only the allowed apps' windows, over the desktop picture: the windows below the desktop icons (the icons are
      // Finder's). A window list, not an app list: the desktop picture belongs to a system app (WindowManager), so an
      // app filter can't show it, and a window that opens after this snapshot stays out of the picture.
      let allowed = Set(apps)
      let desktopIconLevel = Int(CGWindowLevelForKey(.desktopIconWindow))
      let windows = content.windows.filter { window in
        if let id = window.owningApplication?.bundleIdentifier, allowed.contains(id) { return true }
        return window.windowLayer < desktopIconLevel
      }
      if windows.isEmpty {
        // Nothing allowed is on screen, and ScreenCaptureKit refuses an empty list: the picture is blank.
        let scale = Displays.pixelScale(displayID)
        let size = CaptureGeometry.fit(
          width: covered.width * scale, height: covered.height * scale,
          maxWidth: Int(params.maxWidth), maxHeight: Int(params.maxHeight))
        let data = try ImageEncoder.encode(blank(width: size.width, height: size.height), format: params.format, quality: quality)
        return CaptureResult(
          data: data.base64EncodedString(), mime: params.format.mime, width: size.width, height: size.height,
          rect: ScreenRect(covered))
      }
      filter = SCContentFilter(display: display, including: windows)
    } else {
      let own = content.applications.filter { isOwn($0.bundleIdentifier) }
      filter = SCContentFilter(display: display, excludingApplications: own, exceptingWindows: [])
    }

    let scale = Double(filter.pointPixelScale)
    let size = CaptureGeometry.fit(
      width: covered.width * scale, height: covered.height * scale,
      maxWidth: Int(params.maxWidth), maxHeight: Int(params.maxHeight))
    let configuration = SCStreamConfiguration()
    if params.region != nil { configuration.sourceRect = CaptureGeometry.displayLocal(covered, display: bounds) }
    configuration.width = size.width
    configuration.height = size.height
    configuration.showsCursor = true

    let image: CGImage
    do {
      image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
    } catch {
      throw mapError(error)
    }
    let data = try ImageEncoder.encode(image, format: params.format, quality: quality)
    return CaptureResult(
      data: data.base64EncodedString(), mime: params.format.mime, width: image.width, height: image.height,
      rect: ScreenRect(covered))
  }

  /// A black image (CGContext memory starts zeroed, and the alpha is skipped).
  static func blank(width: Int, height: Int) throws -> CGImage {
    guard
      let context = CGContext(
        data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue),
      let image = context.makeImage()
    else { throw RPCError.internal("could not make a blank image") }
    return image
  }

  /// ScreenCaptureKit's "the person declined" is the missing Screen Recording permission.
  static func mapError(_ error: Error) -> RPCError {
    let error = error as NSError
    if error.domain == SCStreamErrorDomain, error.code == SCStreamError.Code.userDeclined.rawValue {
      return .permission(.screenRecording)
    }
    return .internal("screen capture failed: \(error.localizedDescription)")
  }
}
