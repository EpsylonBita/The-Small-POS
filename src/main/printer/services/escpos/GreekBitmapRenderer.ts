/**
 * Greek Bitmap Renderer
 * 
 * Renders Greek text as bitmap images for thermal printers that don't have
 * proper Greek font support. Uses Windows GDI via PowerShell to render
 * Unicode text to 1-bit bitmap, then converts to ESC/POS raster image format.
 * 
 * @module printer/services/escpos
 */

import { execSync, exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { PaperSize } from '../../types';

const execAsync = promisify(exec);

// Paper width in pixels for thermal printers (203 DPI)
const PAPER_WIDTH_PIXELS: Record<PaperSize, number> = {
  [PaperSize.MM_58]: 384,
  [PaperSize.MM_80]: 576,
  [PaperSize.MM_112]: 832,
};

interface FontConfig {
  size: number;
  bold: boolean;
  lineHeight: number;
}

const FONT_CONFIGS: Record<string, FontConfig> = {
  small: { size: 18, bold: false, lineHeight: 26 },
  normal: { size: 22, bold: false, lineHeight: 32 },
  bold: { size: 22, bold: true, lineHeight: 32 },
  header: { size: 28, bold: true, lineHeight: 40 },
  title: { size: 34, bold: true, lineHeight: 48 },
  doubleHeight: { size: 30, bold: false, lineHeight: 42 },
  doubleSize: { size: 38, bold: true, lineHeight: 52 },
  // Special styles for boxed headers (white text on black background)
  boxHeader: { size: 36, bold: true, lineHeight: 52 },
};

export type TextStyle = 'small' | 'normal' | 'bold' | 'header' | 'title' | 'doubleHeight' | 'doubleSize' | 'boxHeader';
export type TextAlign = 'left' | 'center' | 'right';

export interface TextLine {
  text: string;
  style?: TextStyle;
  align?: TextAlign;
  inverted?: boolean;  // White text on black background
  rightText?: string;  // For two-column layout (left text + right text)
}

/**
 * Renders Greek text as bitmap images for ESC/POS printers
 */
export class GreekBitmapRenderer {
  private width: number;
  private tempDir: string;

  constructor(paperSize: PaperSize = PaperSize.MM_80) {
    this.width = PAPER_WIDTH_PIXELS[paperSize];
    this.tempDir = path.join(os.tmpdir(), 'pos-bitmap-render');
    
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }

  static containsGreek(text: string): boolean {
    return /[\u0370-\u03FF\u1F00-\u1FFF]/.test(text);
  }

  private textToPowerShellChars(text: string, varName: string = 'text'): string {
    const lines: string[] = [];
    lines.push('$' + varName + ' = ""');
    
    for (const char of text) {
      const code = char.charCodeAt(0);
      if (code < 128) {
        if (char === '"') {
          lines.push('$' + varName + ' += [char]0x22');
        } else if (char === '$') {
          lines.push('$' + varName + ' += [char]0x24');
        } else if (char === '`') {
          lines.push('$' + varName + ' += [char]0x60');
        } else if (char === "'") {
          lines.push('$' + varName + ' += [char]0x27');
        } else {
          lines.push('$' + varName + ' += "' + char + '"');
        }
      } else {
        lines.push('$' + varName + ' += [char]0x' + code.toString(16).padStart(4, '0').toUpperCase());
      }
    }
    
    return lines.join('\n');
  }

  renderLinesSync(lines: TextLine[]): Buffer {
    // Calculate total height
    let totalHeight = 8;
    for (const line of lines) {
      const config = FONT_CONFIGS[line.style || 'normal'];
      totalHeight += config.lineHeight;
    }
    totalHeight += 8;

    const scriptParts: string[] = [];
    
    scriptParts.push('Add-Type -AssemblyName System.Drawing');
    scriptParts.push('$width = ' + this.width);
    scriptParts.push('$height = ' + totalHeight);
    scriptParts.push('$bitmap = New-Object System.Drawing.Bitmap($width, $height)');
    scriptParts.push('$graphics = [System.Drawing.Graphics]::FromImage($bitmap)');
    scriptParts.push('$graphics.Clear([System.Drawing.Color]::White)');
    scriptParts.push('$graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit');
    scriptParts.push('$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality');
    scriptParts.push('$blackBrush = [System.Drawing.Brushes]::Black');
    scriptParts.push('$whiteBrush = [System.Drawing.Brushes]::White');
    scriptParts.push('$y = 8');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const config = FONT_CONFIGS[line.style || 'normal'];
      const align = line.align || 'left';
      const inverted = line.inverted || line.style === 'boxHeader';
      
      // Build text
      scriptParts.push(this.textToPowerShellChars(line.text, 'text' + i));
      
      // Build right text if present
      if (line.rightText) {
        scriptParts.push(this.textToPowerShellChars(line.rightText, 'rightText' + i));
      }
      
      const fontStyle = config.bold ? '[System.Drawing.FontStyle]::Bold' : '[System.Drawing.FontStyle]::Regular';
      scriptParts.push('$font' + i + ' = New-Object System.Drawing.Font("Arial", ' + config.size + ', ' + fontStyle + ')');
      
      if (inverted) {
        // Draw rounded rectangle (pillow shape) background
        const radius = Math.min(20, Math.floor(config.lineHeight / 3));
        const margin = 10;
        scriptParts.push('$blackPen = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::Black)');
        scriptParts.push('$pillowPath = New-Object System.Drawing.Drawing2D.GraphicsPath');
        scriptParts.push('$pillowRect = New-Object System.Drawing.Rectangle(' + margin + ', $y, ($width - ' + (margin * 2) + '), ' + config.lineHeight + ')');
        scriptParts.push('$radius = ' + radius);
        scriptParts.push('$diameter = $radius * 2');
        scriptParts.push('$pillowPath.AddArc($pillowRect.X, $pillowRect.Y, $diameter, $diameter, 180, 90)');
        scriptParts.push('$pillowPath.AddArc($pillowRect.Right - $diameter, $pillowRect.Y, $diameter, $diameter, 270, 90)');
        scriptParts.push('$pillowPath.AddArc($pillowRect.Right - $diameter, $pillowRect.Bottom - $diameter, $diameter, $diameter, 0, 90)');
        scriptParts.push('$pillowPath.AddArc($pillowRect.X, $pillowRect.Bottom - $diameter, $diameter, $diameter, 90, 90)');
        scriptParts.push('$pillowPath.CloseFigure()');
        scriptParts.push('$graphics.FillPath($blackPen, $pillowPath)');
        scriptParts.push('$brush' + i + ' = $whiteBrush');
      } else {
        scriptParts.push('$brush' + i + ' = $blackBrush');
      }
      
      scriptParts.push('$format' + i + ' = New-Object System.Drawing.StringFormat');
      if (align === 'center') {
        scriptParts.push('$format' + i + '.Alignment = [System.Drawing.StringAlignment]::Center');
      } else if (align === 'right') {
        scriptParts.push('$format' + i + '.Alignment = [System.Drawing.StringAlignment]::Far');
      } else {
        scriptParts.push('$format' + i + '.Alignment = [System.Drawing.StringAlignment]::Near');
      }
      
      const padding = inverted ? 8 : 5;
      scriptParts.push('$rect' + i + ' = New-Object System.Drawing.RectangleF(' + padding + ', ($y + 2), ($width - ' + (padding * 2) + '), ' + (config.lineHeight - 4) + ')');
      scriptParts.push('$graphics.DrawString($text' + i + ', $font' + i + ', $brush' + i + ', $rect' + i + ', $format' + i + ')');
      
      // Draw right text if present (always right-aligned)
      if (line.rightText) {
        scriptParts.push('$formatRight' + i + ' = New-Object System.Drawing.StringFormat');
        scriptParts.push('$formatRight' + i + '.Alignment = [System.Drawing.StringAlignment]::Far');
        scriptParts.push('$graphics.DrawString($rightText' + i + ', $font' + i + ', $brush' + i + ', $rect' + i + ', $formatRight' + i + ')');
      }
      
      scriptParts.push('$font' + i + '.Dispose()');
      scriptParts.push('$y += ' + config.lineHeight);
    }

    // Convert to 1-bit bitmap
    scriptParts.push('$output = @()');
    scriptParts.push('for ($y = 0; $y -lt $height; $y++) {');
    scriptParts.push('    $line = @()');
    scriptParts.push('    for ($x = 0; $x -lt $width; $x += 8) {');
    scriptParts.push('        $byte = 0');
    scriptParts.push('        for ($bit = 0; $bit -lt 8; $bit++) {');
    scriptParts.push('            $px = $x + $bit');
    scriptParts.push('            if ($px -lt $width) {');
    scriptParts.push('                $pixel = $bitmap.GetPixel($px, $y)');
    scriptParts.push('                $gray = ($pixel.R + $pixel.G + $pixel.B) / 3');
    scriptParts.push('                if ($gray -lt 128) {');
    scriptParts.push('                    $byte = $byte -bor (0x80 -shr $bit)');
    scriptParts.push('                }');
    scriptParts.push('            }');
    scriptParts.push('        }');
    scriptParts.push('        $line += $byte');
    scriptParts.push('    }');
    scriptParts.push('    $output += ,($line)');
    scriptParts.push('}');
    scriptParts.push('$graphics.Dispose()');
    scriptParts.push('$bitmap.Dispose()');
    scriptParts.push('$hexOutput = ""');
    scriptParts.push('foreach ($line in $output) {');
    scriptParts.push('    foreach ($b in $line) {');
    scriptParts.push('        $hexOutput += "{0:X2}" -f $b');
    scriptParts.push('    }');
    scriptParts.push('}');
    scriptParts.push('Write-Output $hexOutput');

    const script = scriptParts.join('\n');
    const scriptFile = path.join(this.tempDir, 'render-' + Date.now() + '.ps1');
    
    fs.writeFileSync(scriptFile, script, 'ascii');
    
    let hexOutput: string;
    try {
      hexOutput = execSync('powershell -ExecutionPolicy Bypass -File "' + scriptFile + '"', {
        encoding: 'utf8',
        timeout: 60000,
        windowsHide: true
      }).trim();
    } finally {
      try { fs.unlinkSync(scriptFile); } catch { /* ignore */ }
    }

    const bitmapBytes: number[] = [];
    for (let i = 0; i < hexOutput.length; i += 2) {
      bitmapBytes.push(parseInt(hexOutput.substr(i, 2), 16));
    }

    const bytesPerLine = this.width / 8;
    const bytes: number[] = [];
    
    bytes.push(0x1D, 0x76, 0x30, 0x00);
    bytes.push(bytesPerLine & 0xFF, (bytesPerLine >> 8) & 0xFF);
    bytes.push(totalHeight & 0xFF, (totalHeight >> 8) & 0xFF);
    bytes.push(...bitmapBytes);

    return Buffer.from(bytes);
  }

  renderTextSync(text: string, style: TextStyle = 'normal', align: TextAlign = 'left'): Buffer {
    return this.renderLinesSync([{ text, style, align }]);
  }

  /**
   * Build the PowerShell script for rendering (shared between sync and async)
   */
  private buildRenderScript(lines: TextLine[]): { script: string; totalHeight: number } {
    // Calculate total height
    let totalHeight = 8;
    for (const line of lines) {
      const config = FONT_CONFIGS[line.style || 'normal'];
      totalHeight += config.lineHeight;
    }
    totalHeight += 8;

    const scriptParts: string[] = [];

    scriptParts.push('Add-Type -AssemblyName System.Drawing');
    scriptParts.push('$width = ' + this.width);
    scriptParts.push('$height = ' + totalHeight);
    scriptParts.push('$bitmap = New-Object System.Drawing.Bitmap($width, $height)');
    scriptParts.push('$graphics = [System.Drawing.Graphics]::FromImage($bitmap)');
    scriptParts.push('$graphics.Clear([System.Drawing.Color]::White)');
    scriptParts.push('$graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit');
    scriptParts.push('$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality');
    scriptParts.push('$blackBrush = [System.Drawing.Brushes]::Black');
    scriptParts.push('$whiteBrush = [System.Drawing.Brushes]::White');
    scriptParts.push('$y = 8');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const config = FONT_CONFIGS[line.style || 'normal'];
      const align = line.align || 'left';
      const inverted = line.inverted || line.style === 'boxHeader';

      scriptParts.push(this.textToPowerShellChars(line.text, 'text' + i));

      if (line.rightText) {
        scriptParts.push(this.textToPowerShellChars(line.rightText, 'rightText' + i));
      }

      const fontStyle = config.bold ? '[System.Drawing.FontStyle]::Bold' : '[System.Drawing.FontStyle]::Regular';
      scriptParts.push('$font' + i + ' = New-Object System.Drawing.Font("Arial", ' + config.size + ', ' + fontStyle + ')');

      if (inverted) {
        const radius = Math.min(20, Math.floor(config.lineHeight / 3));
        const margin = 10;
        scriptParts.push('$blackPen = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::Black)');
        scriptParts.push('$pillowPath = New-Object System.Drawing.Drawing2D.GraphicsPath');
        scriptParts.push('$pillowRect = New-Object System.Drawing.Rectangle(' + margin + ', $y, ($width - ' + (margin * 2) + '), ' + config.lineHeight + ')');
        scriptParts.push('$radius = ' + radius);
        scriptParts.push('$diameter = $radius * 2');
        scriptParts.push('$pillowPath.AddArc($pillowRect.X, $pillowRect.Y, $diameter, $diameter, 180, 90)');
        scriptParts.push('$pillowPath.AddArc($pillowRect.Right - $diameter, $pillowRect.Y, $diameter, $diameter, 270, 90)');
        scriptParts.push('$pillowPath.AddArc($pillowRect.Right - $diameter, $pillowRect.Bottom - $diameter, $diameter, $diameter, 0, 90)');
        scriptParts.push('$pillowPath.AddArc($pillowRect.X, $pillowRect.Bottom - $diameter, $diameter, $diameter, 90, 90)');
        scriptParts.push('$pillowPath.CloseFigure()');
        scriptParts.push('$graphics.FillPath($blackPen, $pillowPath)');
        scriptParts.push('$brush' + i + ' = $whiteBrush');
      } else {
        scriptParts.push('$brush' + i + ' = $blackBrush');
      }

      scriptParts.push('$format' + i + ' = New-Object System.Drawing.StringFormat');
      if (align === 'center') {
        scriptParts.push('$format' + i + '.Alignment = [System.Drawing.StringAlignment]::Center');
      } else if (align === 'right') {
        scriptParts.push('$format' + i + '.Alignment = [System.Drawing.StringAlignment]::Far');
      } else {
        scriptParts.push('$format' + i + '.Alignment = [System.Drawing.StringAlignment]::Near');
      }

      const padding = inverted ? 8 : 5;
      scriptParts.push('$rect' + i + ' = New-Object System.Drawing.RectangleF(' + padding + ', ($y + 2), ($width - ' + (padding * 2) + '), ' + (config.lineHeight - 4) + ')');
      scriptParts.push('$graphics.DrawString($text' + i + ', $font' + i + ', $brush' + i + ', $rect' + i + ', $format' + i + ')');

      if (line.rightText) {
        scriptParts.push('$formatRight' + i + ' = New-Object System.Drawing.StringFormat');
        scriptParts.push('$formatRight' + i + '.Alignment = [System.Drawing.StringAlignment]::Far');
        scriptParts.push('$graphics.DrawString($rightText' + i + ', $font' + i + ', $brush' + i + ', $rect' + i + ', $formatRight' + i + ')');
      }

      scriptParts.push('$font' + i + '.Dispose()');
      scriptParts.push('$y += ' + config.lineHeight);
    }

    // OPTIMIZED: Use LockBits for faster pixel access instead of GetPixel
    scriptParts.push('$graphics.Dispose()');
    scriptParts.push('$rect = New-Object System.Drawing.Rectangle(0, 0, $width, $height)');
    scriptParts.push('$bitmapData = $bitmap.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)');
    scriptParts.push('$stride = $bitmapData.Stride');
    scriptParts.push('$ptr = $bitmapData.Scan0');
    scriptParts.push('$bytes = New-Object byte[] ($stride * $height)');
    scriptParts.push('[System.Runtime.InteropServices.Marshal]::Copy($ptr, $bytes, 0, $bytes.Length)');
    scriptParts.push('$bitmap.UnlockBits($bitmapData)');
    scriptParts.push('$bitmap.Dispose()');
    scriptParts.push('$hexOutput = ""');
    scriptParts.push('$bytesPerLine = [Math]::Ceiling($width / 8)');
    scriptParts.push('for ($y = 0; $y -lt $height; $y++) {');
    scriptParts.push('    for ($xByte = 0; $xByte -lt $bytesPerLine; $xByte++) {');
    scriptParts.push('        $byte = 0');
    scriptParts.push('        for ($bit = 0; $bit -lt 8; $bit++) {');
    scriptParts.push('            $px = ($xByte * 8) + $bit');
    scriptParts.push('            if ($px -lt $width) {');
    scriptParts.push('                $idx = ($y * $stride) + ($px * 3)');
    scriptParts.push('                $gray = ([int]$bytes[$idx] + [int]$bytes[$idx+1] + [int]$bytes[$idx+2]) / 3');
    scriptParts.push('                if ($gray -lt 128) { $byte = $byte -bor (0x80 -shr $bit) }');
    scriptParts.push('            }');
    scriptParts.push('        }');
    scriptParts.push('        $hexOutput += "{0:X2}" -f $byte');
    scriptParts.push('    }');
    scriptParts.push('}');
    scriptParts.push('Write-Output $hexOutput');

    return { script: scriptParts.join('\n'), totalHeight };
  }

  /**
   * Parse hex output and create ESC/POS buffer
   */
  private hexToEscPosBuffer(hexOutput: string, totalHeight: number): Buffer {
    const bitmapBytes: number[] = [];
    for (let i = 0; i < hexOutput.length; i += 2) {
      bitmapBytes.push(parseInt(hexOutput.substr(i, 2), 16));
    }

    const bytesPerLine = this.width / 8;
    const bytes: number[] = [];

    bytes.push(0x1D, 0x76, 0x30, 0x00);
    bytes.push(bytesPerLine & 0xFF, (bytesPerLine >> 8) & 0xFF);
    bytes.push(totalHeight & 0xFF, (totalHeight >> 8) & 0xFF);
    bytes.push(...bitmapBytes);

    return Buffer.from(bytes);
  }

  /**
   * Render lines asynchronously - does NOT block the main thread
   */
  async renderLinesAsync(lines: TextLine[]): Promise<Buffer> {
    const { script, totalHeight } = this.buildRenderScript(lines);
    const scriptFile = path.join(this.tempDir, 'render-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9) + '.ps1');

    await fs.promises.writeFile(scriptFile, script, 'ascii');

    try {
      const { stdout } = await execAsync('powershell -ExecutionPolicy Bypass -File "' + scriptFile + '"', {
        encoding: 'utf8',
        timeout: 60000,
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024 // 10MB buffer for large receipts
      });

      return this.hexToEscPosBuffer(stdout.trim(), totalHeight);
    } finally {
      try { await fs.promises.unlink(scriptFile); } catch { /* ignore */ }
    }
  }

  /**
   * Render single text line asynchronously
   */
  async renderTextAsync(text: string, style: TextStyle = 'normal', align: TextAlign = 'left'): Promise<Buffer> {
    return this.renderLinesAsync([{ text, style, align }]);
  }
}
