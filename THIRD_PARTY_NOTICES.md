# Third party notices

The topic overlap helper in `packages/shared/src/topics.ts` adapts the matching loop from [Tacit Protocol scorer.ts](https://github.com/tacitprotocol/tacit/blob/main/packages/sdk-ts/src/matching/scorer.ts), inspected blob `f2213bba7710a75ff6b89b6670cd13e48c001837`. Meeti replaces substring scoring with exact canonical topic eligibility. It does not incorporate authenticity scores or automated consent.

```text
MIT License

Copyright (c) 2026 Tacit Protocol Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Jaini and Manrope font licenses are retained in `public/fonts/JAINI-OFL.txt` and `public/fonts/MANROPE-OFL.txt`. The owner supplied the Meeti logo. Meeti includes owner-authorized frontend patterns adapted from KrowdKraft and Picfind, including branding composition, setup guidance, accessible workspace navigation and responsive layout. Their product branding and unrelated features are not included in the interface. The detailed local review is kept in private project documentation. Package dependency notices remain with their respective packages.

The original Meeti connection instrument is generated using build-time Anatomy geometry and audit helpers. The minimal helper dependency closure is retained in `scripts/artwork/vendor/`, with its MIT license and original copyright notice in `scripts/artwork/vendor/ANATOMY-LICENSE.txt`. The application consumes generated SVG geometry and an owned lamp shader, rather than loading the build-time helper library in the browser. The generator, generated source and public SVG must retain their applicable notices. This third-party license does not declare a license for the whole Meeti application.
