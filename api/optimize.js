import formidable from 'formidable';
import JSZip from 'jszip';
import sharp from 'sharp';

export const config = {
  api: {
    bodyParser: false,
  },
};

// Helper: Optimize image dengan smart detection untuk ModelEngine/ItemsAdder
async function optimizeImage(buffer, filename, options = {}) {
  const { targetResolution = 256, quality = 85, format = 'png', aggressiveMode = false } = options;
  
  try {
    // Validate buffer
    if (!buffer || buffer.length === 0) {
      throw new Error('Empty image buffer');
    }
    
    const image = sharp(buffer);
    const metadata = await image.metadata();
    
    // Validate image metadata
    if (!metadata.width || !metadata.height) {
      console.warn(`Invalid metadata for ${filename}`);
      return buffer;
    }
    
    // Skip jika sudah kecil (16x16 atau 32x32)
    if (metadata.width <= 32 && metadata.height <= 32) {
      return buffer;
    }
    
    let pipeline = image;
    
    // Smart resize berdasarkan ukuran original
    let newWidth = metadata.width;
    let newHeight = metadata.height;
    
    // Untuk HD textures (512x+), downscale ke target
    if (metadata.width >= 512 || metadata.height >= 512) {
      const aspectRatio = metadata.width / metadata.height;
      
      if (aspectRatio === 1) {
        // Square texture (items, blocks)
        newWidth = newHeight = Math.min(targetResolution, metadata.width);
      } else {
        // Rectangular texture (GUI, panorama)
        if (metadata.width > metadata.height) {
          newWidth = Math.min(targetResolution, metadata.width);
          newHeight = Math.round(newWidth / aspectRatio);
        } else {
          newHeight = Math.min(targetResolution, metadata.height);
          newWidth = Math.round(newHeight * aspectRatio);
        }
      }
      
      pipeline = pipeline.resize(newWidth, newHeight, {
        fit: 'contain',
        withoutEnlargement: true,
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      });
    }
    
    // Compression settings
    if (format === 'png') {
      if (aggressiveMode) {
        // Mode aggressive untuk device lemah
        pipeline = pipeline.png({
          quality: quality - 5,
          compressionLevel: 9,
          palette: true,
          colors: 128, // Aggressive color reduction
          effort: 10,
          progressive: true
        });
      } else {
        // Balanced mode
        pipeline = pipeline.png({
          quality,
          compressionLevel: 9,
          adaptiveFiltering: true,
          progressive: true
        });
      }
    } else if (format === 'webp') {
      pipeline = pipeline.webp({
        quality,
        effort: 6,
        alphaQuality: 95
      });
    }
    
    const optimized = await pipeline.toBuffer();
    
    // Only return optimized if smaller
    return optimized.length < buffer.length ? optimized : buffer;
    
  } catch (error) {
    console.error(`Error optimizing ${filename}:`, error.message);
    return buffer;
  }
}

// Helper: Check if image file
const isImageFile = (filename) => /\.(png|jpg|jpeg)$/i.test(filename);

// Helper: Critical files yang TIDAK boleh diubah
const isCriticalFile = (filename) => {
  const criticalPatterns = [
    /^pack\.mcmeta$/i,
    /^pack\.png$/i,
    /\.mcmeta$/i, // Animation files
    /\.json$/i, // Model definitions
    /\.bbmodel$/i,
    /\.txt$/i,
    /\.properties$/i,
    /font\//i
  ];
  
  return criticalPatterns.some(pattern => pattern.test(filename));
};

// Helper: Sound files yang perlu dikompres
const isSoundFile = (filename) => /\.(ogg|wav|mp3)$/i.test(filename);

// Helper: Detect folder priority (untuk targeting optimization)
const getFolderPriority = (filename) => {
  const path = filename.toLowerCase();
  
  // ModelEngine textures (HIGH PRIORITY - biasanya HD)
  if (path.includes('modelengine')) return 'high';
  
  // Custom character/mob textures (HIGH PRIORITY)
  if (path.match(/(ninja|samurai|warrior|mage|assassin|paladin|reaper|dragon|awakened)/)) {
    return 'high';
  }
  
  // Items/weapons (MEDIUM PRIORITY)
  if (path.includes('items') || path.includes('weapons')) return 'medium';
  
  // Minecraft vanilla assets (LOW PRIORITY - keep quality)
  if (path.includes('assets/minecraft/textures/')) return 'low';
  
  return 'medium';
};

// Helper: Get optimal resolution based on priority
const getOptimalResolution = (filename, baseResolution, priority) => {
  switch(priority) {
    case 'high':
      return Math.min(baseResolution, 256); // Aggressive untuk ModelEngine
    case 'medium':
      return baseResolution;
    case 'low':
      return Math.min(baseResolution * 1.5, 512); // Preserve vanilla quality
    default:
      return baseResolution;
  }
};

// Main handler
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  try {
    const form = formidable({
      maxFileSize: 150 * 1024 * 1024,
      keepExtensions: true,
    });
    
    const [fields, files] = await new Promise((resolve, reject) => {
      form.parse(req, (err, fields, files) => {
        if (err) reject(err);
        resolve([fields, files]);
      });
    });
    
    const uploadedFile = files.file?.[0] || files.file;
    if (!uploadedFile) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    
    // Get options
    const targetResolution = parseInt(fields.resolution?.[0] || fields.resolution || '256');
    const quality = parseInt(fields.quality?.[0] || fields.quality || '85');
    const format = fields.format?.[0] || fields.format || 'png';
    const aggressiveMode = (fields.aggressive?.[0] || fields.aggressive) === 'true';
    const deviceMode = fields.deviceMode?.[0] || fields.deviceMode || 'potato'; // potato/balanced/quality
    
    // Read ZIP
    const fs = await import('fs');
    const fileBuffer = await fs.promises.readFile(uploadedFile.filepath);
    const zip = await JSZip.loadAsync(fileBuffer);
    
    const optimizedZip = new JSZip();
    
    let stats = {
      totalFiles: 0,
      imageFiles: 0,
      soundFiles: 0,
      optimizedImages: 0,
      skippedFiles: 0,
      criticalFiles: 0,
      hdTexturesFound: 0,
      originalSize: 0,
      optimizedSize: 0,
      categories: {
        modelengine: { files: 0, saved: 0 },
        items: { files: 0, saved: 0 },
        vanilla: { files: 0, saved: 0 },
        sounds: { files: 0, saved: 0 }
      }
    };
    
    // Process each file
    for (const [filename, file] of Object.entries(zip.files)) {
      if (file.dir) {
        optimizedZip.folder(filename);
        continue;
      }
      
      stats.totalFiles++;
      const fileData = await file.async('nodebuffer');
      const originalSize = fileData.length;
      stats.originalSize += originalSize;
      
      // Skip critical files
      if (isCriticalFile(filename)) {
        optimizedZip.file(filename, fileData);
        stats.optimizedSize += originalSize;
        stats.criticalFiles++;
        continue;
      }
      
      // Handle sounds (just copy, no compression yet)
      if (isSoundFile(filename)) {
        optimizedZip.file(filename, fileData);
        stats.optimizedSize += originalSize;
        stats.soundFiles++;
        stats.categories.sounds.files++;
        continue;
      }
      
      // Handle images
      if (isImageFile(filename)) {
        stats.imageFiles++;
        
        try {
          // Detect folder priority
          const priority = getFolderPriority(filename);
          const optimalRes = getOptimalResolution(filename, targetResolution, priority);
          
          // Check if HD texture
          const metadata = await sharp(fileData).metadata();
          if (metadata.width >= 512 || metadata.height >= 512) {
            stats.hdTexturesFound++;
          }
          
          // Optimize with smart settings
          const optimized = await optimizeImage(fileData, filename, {
            targetResolution: deviceMode === 'potato' ? Math.min(optimalRes, 256) : optimalRes,
            quality: deviceMode === 'potato' ? quality - 10 : quality,
            format,
            aggressiveMode: aggressiveMode || deviceMode === 'potato'
          });
          
          let newFilename = filename;
          if (format !== 'png' && filename.endsWith('.png')) {
            newFilename = filename.replace(/\.png$/i, `.${format}`);
          }
          
          const saved = originalSize - optimized.length;
          
          optimizedZip.file(newFilename, optimized);
          stats.optimizedSize += optimized.length;
          stats.optimizedImages++;
          
          // Categorize savings
          if (filename.includes('modelengine')) {
            stats.categories.modelengine.files++;
            stats.categories.modelengine.saved += saved;
          } else if (filename.includes('items') || filename.includes('weapons')) {
            stats.categories.items.files++;
            stats.categories.items.saved += saved;
          } else if (filename.includes('assets/minecraft')) {
            stats.categories.vanilla.files++;
            stats.categories.vanilla.saved += saved;
          }
          
        } catch (error) {
          console.error(`Error processing ${filename}:`, error.message);
          optimizedZip.file(filename, fileData);
          stats.optimizedSize += originalSize;
          stats.skippedFiles++;
        }
      } else {
        // Other files (copy as-is)
        optimizedZip.file(filename, fileData);
        stats.optimizedSize += originalSize;
      }
    }
    
    // Generate optimized ZIP with maximum compression
    const optimizedBuffer = await optimizedZip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 9 }
    });
    
    // Calculate final stats
    const finalSize = optimizedBuffer.length;
    const savedBytes = stats.originalSize - finalSize;
    const savedPercent = ((savedBytes / stats.originalSize) * 100).toFixed(2);
    const finalSizeMB = (finalSize / 1024 / 1024).toFixed(2);
    
    stats.finalZipSize = finalSize;
    stats.savedBytes = savedBytes;
    stats.savedPercent = savedPercent;
    stats.finalSizeMB = finalSizeMB;
    stats.targetAchieved = finalSize <= (13 * 1024 * 1024); // 13MB target
    
    // Generate filename
    const originalName = uploadedFile.originalFilename || 'pack.zip';
    const outputName = originalName.replace('.zip', `-optimized-${finalSizeMB}mb.zip`);
    
    // Send response
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${outputName}"`);
    res.setHeader('X-Stats', JSON.stringify(stats));
    
    return res.status(200).send(optimizedBuffer);
    
  } catch (error) {
    console.error('Error processing:', error);
    
    // Log detailed error untuk debugging
    const errorDetails = {
      message: error.message,
      stack: error.stack,
      name: error.name
    };
    
    // Send user-friendly error message
    let userMessage = 'Failed to process texture pack';
    
    if (error.message.includes('sharp')) {
      userMessage = 'Image processing error. Please try again or use smaller resolution.';
    } else if (error.message.includes('timeout')) {
      userMessage = 'Processing timeout. Try Potato Mode or smaller file.';
    } else if (error.message.includes('memory')) {
      userMessage = 'Out of memory. Try reducing quality or resolution.';
    } else if (error.message.includes('invalid')) {
      userMessage = 'Invalid ZIP file or corrupted textures detected.';
    }
    
    return res.status(500).json({
      error: userMessage,
      details: process.env.NODE_ENV === 'development' ? errorDetails : undefined,
      suggestion: 'Try: Potato Mode + 256x resolution + Quality 75%'
    });
  }
}    /font\//i
  ];
  
  return criticalPatterns.some(pattern => pattern.test(filename));
};

// Helper: Sound files yang perlu dikompres
const isSoundFile = (filename) => /\.(ogg|wav|mp3)$/i.test(filename);

// Helper: Detect folder priority (untuk targeting optimization)
const getFolderPriority = (filename) => {
  const path = filename.toLowerCase();
  
  // ModelEngine textures (HIGH PRIORITY - biasanya HD)
  if (path.includes('modelengine')) return 'high';
  
  // Custom character/mob textures (HIGH PRIORITY)
  if (path.match(/(ninja|samurai|warrior|mage|assassin|paladin|reaper|dragon|awakened)/)) {
    return 'high';
  }
  
  // Items/weapons (MEDIUM PRIORITY)
  if (path.includes('items') || path.includes('weapons')) return 'medium';
  
  // Minecraft vanilla assets (LOW PRIORITY - keep quality)
  if (path.includes('assets/minecraft/textures/')) return 'low';
  
  return 'medium';
};

// Helper: Get optimal resolution based on priority
const getOptimalResolution = (filename, baseResolution, priority) => {
  switch(priority) {
    case 'high':
      return Math.min(baseResolution, 256); // Aggressive untuk ModelEngine
    case 'medium':
      return baseResolution;
    case 'low':
      return Math.min(baseResolution * 1.5, 512); // Preserve vanilla quality
    default:
      return baseResolution;
  }
};

// Main handler
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  try {
    const form = formidable({
      maxFileSize: 150 * 1024 * 1024,
      keepExtensions: true,
    });
    
    const [fields, files] = await new Promise((resolve, reject) => {
      form.parse(req, (err, fields, files) => {
        if (err) reject(err);
        resolve([fields, files]);
      });
    });
    
    const uploadedFile = files.file?.[0] || files.file;
    if (!uploadedFile) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    
    // Get options
    const targetResolution = parseInt(fields.resolution?.[0] || fields.resolution || '256');
    const quality = parseInt(fields.quality?.[0] || fields.quality || '85');
    const format = fields.format?.[0] || fields.format || 'png';
    const aggressiveMode = (fields.aggressive?.[0] || fields.aggressive) === 'true';
    const deviceMode = fields.deviceMode?.[0] || fields.deviceMode || 'potato'; // potato/balanced/quality
    
    // Read ZIP
    const fs = await import('fs');
    const fileBuffer = await fs.promises.readFile(uploadedFile.filepath);
    const zip = await JSZip.loadAsync(fileBuffer);
    
    const optimizedZip = new JSZip();
    
    let stats = {
      totalFiles: 0,
      imageFiles: 0,
      soundFiles: 0,
      optimizedImages: 0,
      skippedFiles: 0,
      criticalFiles: 0,
      hdTexturesFound: 0,
      originalSize: 0,
      optimizedSize: 0,
      categories: {
        modelengine: { files: 0, saved: 0 },
        items: { files: 0, saved: 0 },
        vanilla: { files: 0, saved: 0 },
        sounds: { files: 0, saved: 0 }
      }
    };
    
    // Process each file
    for (const [filename, file] of Object.entries(zip.files)) {
      if (file.dir) {
        optimizedZip.folder(filename);
        continue;
      }
      
      stats.totalFiles++;
      const fileData = await file.async('nodebuffer');
      const originalSize = fileData.length;
      stats.originalSize += originalSize;
      
      // Skip critical files
      if (isCriticalFile(filename)) {
        optimizedZip.file(filename, fileData);
        stats.optimizedSize += originalSize;
        stats.criticalFiles++;
        continue;
      }
      
      // Handle sounds (just copy, no compression yet)
      if (isSoundFile(filename)) {
        optimizedZip.file(filename, fileData);
        stats.optimizedSize += originalSize;
        stats.soundFiles++;
        stats.categories.sounds.files++;
        continue;
      }
      
      // Handle images
      if (isImageFile(filename)) {
        stats.imageFiles++;
        
        try {
          // Detect folder priority
          const priority = getFolderPriority(filename);
          const optimalRes = getOptimalResolution(filename, targetResolution, priority);
          
          // Check if HD texture
          const metadata = await sharp(fileData).metadata();
          if (metadata.width >= 512 || metadata.height >= 512) {
            stats.hdTexturesFound++;
          }
          
          // Optimize with smart settings
          const optimized = await optimizeImage(fileData, filename, {
            targetResolution: deviceMode === 'potato' ? Math.min(optimalRes, 256) : optimalRes,
            quality: deviceMode === 'potato' ? quality - 10 : quality,
            format,
            aggressiveMode: aggressiveMode || deviceMode === 'potato'
          });
          
          let newFilename = filename;
          if (format !== 'png' && filename.endsWith('.png')) {
            newFilename = filename.replace(/\.png$/i, `.${format}`);
          }
          
          const saved = originalSize - optimized.length;
          
          optimizedZip.file(newFilename, optimized);
          stats.optimizedSize += optimized.length;
          stats.optimizedImages++;
          
          // Categorize savings
          if (filename.includes('modelengine')) {
            stats.categories.modelengine.files++;
            stats.categories.modelengine.saved += saved;
          } else if (filename.includes('items') || filename.includes('weapons')) {
            stats.categories.items.files++;
            stats.categories.items.saved += saved;
          } else if (filename.includes('assets/minecraft')) {
            stats.categories.vanilla.files++;
            stats.categories.vanilla.saved += saved;
          }
          
        } catch (error) {
          console.error(`Error processing ${filename}:`, error.message);
          optimizedZip.file(filename, fileData);
          stats.optimizedSize += originalSize;
          stats.skippedFiles++;
        }
      } else {
        // Other files (copy as-is)
        optimizedZip.file(filename, fileData);
        stats.optimizedSize += originalSize;
      }
    }
    
    // Generate optimized ZIP with maximum compression
    const optimizedBuffer = await optimizedZip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 9 }
    });
    
    // Calculate final stats
    const finalSize = optimizedBuffer.length;
    const savedBytes = stats.originalSize - finalSize;
    const savedPercent = ((savedBytes / stats.originalSize) * 100).toFixed(2);
    const finalSizeMB = (finalSize / 1024 / 1024).toFixed(2);
    
    stats.finalZipSize = finalSize;
    stats.savedBytes = savedBytes;
    stats.savedPercent = savedPercent;
    stats.finalSizeMB = finalSizeMB;
    stats.targetAchieved = finalSize <= (13 * 1024 * 1024); // 13MB target
    
    // Generate filename
    const originalName = uploadedFile.originalFilename || 'pack.zip';
    const outputName = originalName.replace('.zip', `-optimized-${finalSizeMB}mb.zip`);
    
    // Send response
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${outputName}"`);
    res.setHeader('X-Stats', JSON.stringify(stats));
    
    return res.status(200).send(optimizedBuffer);
    
  } catch (error) {
    console.error('Error processing:', error);
    return res.status(500).json({
      error: 'Failed to process texture pack',
      message: error.message
    });
  }
            }
