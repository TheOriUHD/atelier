import UIKit

/// Pictures made smaller before they leave the device: a profile photo, the pictures of an issue report.
enum PersonalImages {
    struct Picture: Equatable {
        let data: Data
        let width: Int
        let height: Int
    }

    /// A JPEG whose longest side is at most `maxSide` points of pixels and whose size is at most `maxBytes`, or nil for something that isn't a picture.
    static func jpeg(from data: Data, maxSide: CGFloat, maxBytes: Int) -> Picture? {
        guard let image = UIImage(data: data) else { return nil }
        var side = min(maxSide, max(image.size.width * image.scale, image.size.height * image.scale))
        for _ in 0..<6 {
            let scale = side / max(image.size.width * image.scale, image.size.height * image.scale, 1)
            let size = CGSize(width: max(1, (image.size.width * image.scale * min(1, scale)).rounded()), height: max(1, (image.size.height * image.scale * min(1, scale)).rounded()))
            let format = UIGraphicsImageRendererFormat(); format.scale = 1; format.opaque = true
            let rendered = UIGraphicsImageRenderer(size: size, format: format).image { context in
                UIColor.white.setFill(); context.fill(CGRect(origin: .zero, size: size))
                image.draw(in: CGRect(origin: .zero, size: size))
            }
            for quality in [0.85, 0.7, 0.55, 0.4] as [CGFloat] {
                if let encoded = rendered.jpegData(compressionQuality: quality), encoded.count <= maxBytes {
                    return Picture(data: encoded, width: Int(size.width), height: Int(size.height))
                }
            }
            side *= 0.75
        }
        return nil
    }
}
