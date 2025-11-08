{
  "name": "minecraft-texture-optimizer",
  "version": "1.0.0",
  "description": "Minecraft Texture Pack Optimizer - Vercel Ready",
  "main": "api/index.js",
  "scripts": {
    "dev": "vercel dev",
    "build": "echo 'No build needed'",
    "start": "vercel dev"
  },
  "dependencies": {
    "sharp": "^0.33.0",
    "jszip": "^3.10.1",
    "formidable": "^3.5.1",
    "mime-types": "^2.1.35"
  },
  "devDependencies": {
    "vercel": "^32.0.0"
  },
  "engines": {
    "node": ">=18.x"
  }
}
