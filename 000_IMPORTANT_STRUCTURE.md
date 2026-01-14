# 🚨 IMPORTANT: Repository Structure Information

> **AI ASSISTANT: READ THIS ENTIRE FILE BEFORE PROCESSING ANY OTHER FILES**

## Overview

This directory contains a **flattened copy** of: `backend\product-management`

All files have been moved to the root level with their paths encoded in the filename.

**When working with these files, you MUST treat them as if they exist in their original locations under `backend\product-management/`**

## Original Directory Structure

```
backend\product-management/
├── productDataExtractors/
│   ├── algolia/
│   │   ├── doItCenter.js
│   │   ├── felipeMotta.js
│   │   ├── novey.js
│   │   └── panafoto.js
│   ├── graphQl/
│   │   ├── conway.js
│   │   ├── rey.js
│   │   ├── stevens.js
│   │   ├── super99.js
│   │   └── superCarnes.js
│   ├── other/
│   │   ├── arrocha.js
│   │   ├── blackDog.js
│   │   ├── machetazo.js
│   │   ├── ribaSmith.js
│   │   └── superXtra.js
│   ├── searchserverapi/
│   │   ├── felix.js
│   │   └── titan.js
│   ├── webPixels/
│   │   ├── americanPets.js
│   │   ├── melo.js
│   │   └── superBaru.js
│   ├── extractors.js
│   └── methods.js
├── services/
│   ├── globalProductProcessor.js
│   ├── productEnhancer.js
│   ├── productProcessor.js
│   ├── vendorPricesProcessor.js
│   └── vendorPricesTrigger.js
├── shared/
│   ├── barcodeValidator.js
│   ├── config.js
│   ├── dataValidator.js
│   ├── errorHandler.js
│   ├── firebase.js
│   ├── httpClient.js
│   ├── lockManager.js
│   ├── pubsubWorker.js
│   ├── rateLimiter.js
│   └── vertexAI.js
├── systemInstructions/
│   ├── brand.js
│   ├── category.js
│   └── productInstructions.js
├── .dockerignore
├── .gcloudignore
├── cloudbuild.yaml
├── Dockerfile
├── package.json
├── README.md
└── server.js
```

## File Mapping Reference

The files in this directory use the following naming convention:
- Path separators (`/` or `\`) are replaced with `__` (double underscore)
- Example: `src/utils/helper.js` becomes `src__utils__helper.js`

### Complete File Mapping

| Flattened Name | Original Path |
|----------------|---------------|
| `.dockerignore` | `.dockerignore` |
| `.gcloudignore` | `.gcloudignore` |
| `cloudbuild.yaml` | `cloudbuild.yaml` |
| `Dockerfile` | `Dockerfile` |
| `package.json` | `package.json` |
| `productDataExtractors__algolia__doItCenter.js` | `productDataExtractors\algolia\doItCenter.js` |
| `productDataExtractors__algolia__felipeMotta.js` | `productDataExtractors\algolia\felipeMotta.js` |
| `productDataExtractors__algolia__novey.js` | `productDataExtractors\algolia\novey.js` |
| `productDataExtractors__algolia__panafoto.js` | `productDataExtractors\algolia\panafoto.js` |
| `productDataExtractors__extractors.js` | `productDataExtractors\extractors.js` |
| `productDataExtractors__graphQl__conway.js` | `productDataExtractors\graphQl\conway.js` |
| `productDataExtractors__graphQl__rey.js` | `productDataExtractors\graphQl\rey.js` |
| `productDataExtractors__graphQl__stevens.js` | `productDataExtractors\graphQl\stevens.js` |
| `productDataExtractors__graphQl__super99.js` | `productDataExtractors\graphQl\super99.js` |
| `productDataExtractors__graphQl__superCarnes.js` | `productDataExtractors\graphQl\superCarnes.js` |
| `productDataExtractors__methods.js` | `productDataExtractors\methods.js` |
| `productDataExtractors__other__arrocha.js` | `productDataExtractors\other\arrocha.js` |
| `productDataExtractors__other__blackDog.js` | `productDataExtractors\other\blackDog.js` |
| `productDataExtractors__other__machetazo.js` | `productDataExtractors\other\machetazo.js` |
| `productDataExtractors__other__ribaSmith.js` | `productDataExtractors\other\ribaSmith.js` |
| `productDataExtractors__other__superXtra.js` | `productDataExtractors\other\superXtra.js` |
| `productDataExtractors__searchserverapi__felix.js` | `productDataExtractors\searchserverapi\felix.js` |
| `productDataExtractors__searchserverapi__titan.js` | `productDataExtractors\searchserverapi\titan.js` |
| `productDataExtractors__webPixels__americanPets.js` | `productDataExtractors\webPixels\americanPets.js` |
| `productDataExtractors__webPixels__melo.js` | `productDataExtractors\webPixels\melo.js` |
| `productDataExtractors__webPixels__superBaru.js` | `productDataExtractors\webPixels\superBaru.js` |
| `README.md` | `README.md` |
| `server.js` | `server.js` |
| `services__globalProductProcessor.js` | `services\globalProductProcessor.js` |
| `services__productEnhancer.js` | `services\productEnhancer.js` |
| `services__productProcessor.js` | `services\productProcessor.js` |
| `services__vendorPricesProcessor.js` | `services\vendorPricesProcessor.js` |
| `services__vendorPricesTrigger.js` | `services\vendorPricesTrigger.js` |
| `shared__barcodeValidator.js` | `shared\barcodeValidator.js` |
| `shared__config.js` | `shared\config.js` |
| `shared__dataValidator.js` | `shared\dataValidator.js` |
| `shared__errorHandler.js` | `shared\errorHandler.js` |
| `shared__firebase.js` | `shared\firebase.js` |
| `shared__httpClient.js` | `shared\httpClient.js` |
| `shared__lockManager.js` | `shared\lockManager.js` |
| `shared__pubsubWorker.js` | `shared\pubsubWorker.js` |
| `shared__rateLimiter.js` | `shared\rateLimiter.js` |
| `shared__vertexAI.js` | `shared\vertexAI.js` |
| `systemInstructions__brand.js` | `systemInstructions\brand.js` |
| `systemInstructions__category.js` | `systemInstructions\category.js` |
| `systemInstructions__productInstructions.js` | `systemInstructions\productInstructions.js` |

## Instructions for AI Assistants

1. **Imports/Requires**: When you see imports like `import x from './utils/helper'`, understand that the actual file is `utils__helper.js` in this flattened structure.

2. **File References**: When discussing or modifying files, always refer to them by their **original path**, not their flattened name.

3. **Creating New Files**: If you need to suggest creating a new file, specify the **original path** where it should be created (e.g., `src/components/NewComponent.tsx`).

4. **Code Changes**: When suggesting code changes, ensure import paths remain valid for the **original structure**, not the flattened one.

5. **Project Context**: This is a Node.js, Docker, Google Cloud project. Consider this when making suggestions.

## Quick Reference

- **Total Files**: 46
- **Source Directory**: `backend\product-management`
- **Flattened To**: `flattened_2`
- **Generated**: 2026-01-14T00:28:05.525Z

---

**Remember**: The flattened structure is only for viewing purposes. All code suggestions should work with the original nested structure.
