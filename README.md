# `zip-phonegap-demo`

A phonegap app that demonstrates the use of Javascript zip libraries.

The app simply runs `benchmark.js` against various Javascript zip library implementations.

Hit the "Run" button, and go do something else for a while -
it takes a long time to complete!

## Status

This project is merely a demo app, and is very much a work in progress.
If anything works, or is even complete... that's a bonus!

## Instructions

To set up the project, run the following commands:

```bash
git clone git@github.com:bguiz/zip-phonegap-demo.git
cd zip-phonegap-demo
npm run install
# For *nix systems
npm installdeps
# OR, for Windows systems
npm run windowsinstalldeps
```

Note that the `npm` command is used here as a *convenience* to install
any 3rd party dependencies.
This **is not** a NodeJs module, and is not published on the NPM registry -
this is just a regular phonegap/ cordova project.

### phonegap-android build

To build the Android target:

- Install Android SDK 22
- Ensure that `ANDROID_HOME` environment variable is set
- Run the following commands:

```bash
npm install --global phonegap
npm run setupandroid
npm run buildandroid
// Find APK in ./platforms/android/build/outputs/apk/*.apk
```

### phonegap-windows build

To build the Windows and Windows Phone targets:

- Install Microsoft Visual Studio 2015
- Run the following commands:

```bash
npm run setupwindows
npm run buildwindows
// Find MSVS solution in platforms\windows\CordovaApp.sln
```

Open the MSVS solution in Visual Studio, and take it from there.

## Contributing

This repository uses the **git flow** branching strategy.
If you wish to contribute, please branch from the **develop** branch -
pull requests will only be requested if they request merging into the develop branch.

## Author

Maintained by Brendan Graetz

[bguiz.com](http://bguiz.com/)

## Licence

GPLv3
