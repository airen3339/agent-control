import AppKit
import CoreGraphics
import Foundation

guard CommandLine.arguments.count >= 2 else {
  fputs("Usage: render-icon.swift <output.png>\n", stderr)
  exit(2)
}

let outputPath = CommandLine.arguments[1]
let size = 1024
let colorSpace = CGColorSpaceCreateDeviceRGB()
guard let ctx = CGContext(
  data: nil,
  width: size,
  height: size,
  bitsPerComponent: 8,
  bytesPerRow: 0,
  space: colorSpace,
  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
) else {
  fputs("Failed to create CGContext\n", stderr)
  exit(1)
}

let rect = CGRect(x: 0, y: 0, width: size, height: size)
ctx.clear(rect)

// Rounded macOS icon canvas (inset 100px for standard macOS Big Sur+ shadow margin)
let inset: CGFloat = 100
let cardRect = rect.insetBy(dx: inset, dy: inset)
let cornerRadius: CGFloat = 186
let cardPath = CGPath(roundedRect: cardRect, cornerWidth: cornerRadius, cornerHeight: cornerRadius, transform: nil)

ctx.saveGState()
ctx.setShadow(offset: CGSize(width: 0, height: -18), blur: 36, color: CGColor(red: 0, green: 0, blue: 0, alpha: 0.48))
ctx.addPath(cardPath)
ctx.setFillColor(CGColor(red: 13/255, green: 18/255, blue: 26/255, alpha: 1))
ctx.fillPath()
ctx.restoreGState()

ctx.saveGState()
ctx.addPath(cardPath)
ctx.clip()

// Subtle top-to-bottom dark gradient
let bgColors = [
  CGColor(red: 22/255, green: 31/255, blue: 46/255, alpha: 1),
  CGColor(red: 10/255, green: 14/255, blue: 22/255, alpha: 1),
] as CFArray
if let bgGradient = CGGradient(colorsSpace: colorSpace, colors: bgColors, locations: [0, 1]) {
  ctx.drawLinearGradient(
    bgGradient,
    start: CGPoint(x: size / 2, y: Int(cardRect.maxY)),
    end: CGPoint(x: size / 2, y: Int(cardRect.minY)),
    options: []
  )
}

// Radial blue glow in center
let glowColors = [
  CGColor(red: 76/255, green: 141/255, blue: 255/255, alpha: 0.24),
  CGColor(red: 76/255, green: 141/255, blue: 255/255, alpha: 0.0),
] as CFArray
if let glow = CGGradient(colorsSpace: colorSpace, colors: glowColors, locations: [0, 1]) {
  ctx.drawRadialGradient(
    glow,
    startCenter: CGPoint(x: 512, y: 528),
    startRadius: 20,
    endCenter: CGPoint(x: 512, y: 528),
    endRadius: 360,
    options: []
  )
}

// Inner subtle border
ctx.addPath(cardPath)
ctx.setStrokeColor(CGColor(red: 124/255, green: 158/255, blue: 219/255, alpha: 0.34))
ctx.setLineWidth(6)
ctx.strokePath()
ctx.restoreGState()

// Multi-agent hub motif: central hub + 3 connected agent nodes
let center = CGPoint(x: 512, y: 512)
let nodes: [(CGPoint, CGColor)] = [
  (CGPoint(x: 512, y: 716), CGColor(red: 76/255, green: 141/255, blue: 255/255, alpha: 1)),   // Codex / Accent blue
  (CGPoint(x: 332, y: 392), CGColor(red: 52/255, green: 211/255, blue: 153/255, alpha: 1)),   // Emerald
  (CGPoint(x: 692, y: 392), CGColor(red: 167/255, green: 139/255, blue: 250/255, alpha: 1)),  // Violet
]

// Outer orbital ring
ctx.saveGState()
ctx.setStrokeColor(CGColor(red: 147/255, green: 161/255, blue: 181/255, alpha: 0.20))
ctx.setLineWidth(10)
ctx.addEllipse(in: CGRect(x: 294, y: 294, width: 436, height: 436))
ctx.strokePath()
ctx.restoreGState()

// Connection spokes
ctx.saveGState()
ctx.setLineCap(.round)
ctx.setLineWidth(20)
ctx.setStrokeColor(CGColor(red: 124/255, green: 158/255, blue: 219/255, alpha: 0.52))
for (pt, _) in nodes {
  ctx.move(to: center)
  ctx.addLine(to: pt)
  ctx.strokePath()
}
ctx.restoreGState()

// Outer agent nodes
for (pt, color) in nodes {
  let outerR: CGFloat = 52
  ctx.saveGState()
  ctx.setShadow(offset: CGSize(width: 0, height: -4), blur: 18, color: color)
  ctx.setFillColor(CGColor(red: 19/255, green: 26/255, blue: 37/255, alpha: 1))
  ctx.fillEllipse(in: CGRect(x: pt.x - outerR, y: pt.y - outerR, width: outerR * 2, height: outerR * 2))
  ctx.restoreGState()

  ctx.setStrokeColor(color)
  ctx.setLineWidth(12)
  ctx.strokeEllipse(in: CGRect(x: pt.x - outerR, y: pt.y - outerR, width: outerR * 2, height: outerR * 2))

  let dotR: CGFloat = 20
  ctx.setFillColor(color)
  ctx.fillEllipse(in: CGRect(x: pt.x - dotR, y: pt.y - dotR, width: dotR * 2, height: dotR * 2))
}

// Central core
let coreOuter: CGFloat = 86
ctx.saveGState()
ctx.setShadow(offset: CGSize(width: 0, height: -6), blur: 26, color: CGColor(red: 76/255, green: 141/255, blue: 255/255, alpha: 0.65))
ctx.setFillColor(CGColor(red: 76/255, green: 141/255, blue: 255/255, alpha: 1))
ctx.fillEllipse(in: CGRect(x: center.x - coreOuter, y: center.y - coreOuter, width: coreOuter * 2, height: coreOuter * 2))
ctx.restoreGState()

let coreInner: CGFloat = 34
ctx.setFillColor(CGColor(red: 232/255, green: 238/255, blue: 247/255, alpha: 1))
ctx.fillEllipse(in: CGRect(x: center.x - coreInner, y: center.y - coreInner, width: coreInner * 2, height: coreInner * 2))

guard let cgImage = ctx.makeImage() else {
  fputs("Failed to make CGImage\n", stderr)
  exit(1)
}

let rep = NSBitmapImageRep(cgImage: cgImage)
guard let pngData = rep.representation(using: .png, properties: [:]) else {
  fputs("Failed to encode PNG\n", stderr)
  exit(1)
}
try pngData.write(to: URL(fileURLWithPath: outputPath))
