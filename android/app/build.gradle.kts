plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Use a Java 17 toolchain so the build is reproducible regardless of the
// JDK running Gradle (the daemon JVM). Gradle will auto-provision a JDK 17
// if one is not already installed on the host.
java {
    toolchain {
        languageVersion.set(JavaLanguageVersion.of(17))
    }
}

android {
    namespace = "com.spotpicker.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.spotpicker.app"
        minSdk = 26
        targetSdk = 35
        // Bumped so the phone treats this build as a real upgrade of the
        // installed app instead of refusing it as a duplicate.
        versionCode = 3
        versionName = "1.2"
    }

    buildTypes {
        release {
            // The APK is meant to be side-loaded straight onto a phone, so it is
            // signed with the debug key. That keeps installation a one-tap process
            // instead of requiring a keystore setup.
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("debug")
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        viewBinding = true
    }

    // The web app fetches its offline place database (assets/data/**.json)
    // through WebViewAssetLoader, which hands AssetManager file descriptors to
    // the page. A deflated zip entry has no file descriptor, so every request
    // would 404 — keeping JSON stored uncompressed is what makes the bundled
    // gazetteer loadable from the APK.
    androidResources {
        noCompress.add("json")
    }

    sourceSets {
        getByName("main") {
            java.srcDirs("src/main/java")
        }
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    // WebViewAssetLoader serves the bundled web app from a secure https origin,
    // which is what makes localStorage (saved spots) work inside the WebView.
    implementation("androidx.webkit:webkit:1.11.0")
    implementation("com.google.android.material:material:1.12.0")
    // The phone's own fingerprint sheet. A WebView has no platform
    // authenticator, so this is the only way the app can be opened by the
    // fingerprint registered on the device. 1.1.0 covers API 26+ from a single
    // call site (BiometricPrompt on API 28+, FingerprintManager below it).
    implementation("androidx.biometric:biometric:1.1.0")
}

/**
 * Copies the production web build (../dist) into the APK's assets.
 * Run `npm run build` in the project root before building the APK.
 *
 * This is a Sync rather than a Copy on purpose: Vite emits content-hashed file
 * names, so every web build leaves behind orphaned assets. Sync deletes whatever
 * is in the destination but not in the source, which keeps the APK from growing
 * by a dead bundle on every single build.
 */
val syncWebApp by tasks.registering(Sync::class) {
    description = "Copies the built web app into the APK assets."
    from(rootProject.layout.projectDirectory.dir("../dist"))
    into(layout.buildDirectory.dir("generated/webassets"))
}

android.sourceSets.getByName("main") {
    assets.srcDir(layout.buildDirectory.dir("generated/webassets"))
}

/*
 * Every task that reads the generated assets folder must run after syncWebApp.
 * preBuild covers the normal build graph; the explicit matchers cover the
 * asset-merge and lint tasks, which otherwise trip Gradle's implicit-dependency
 * validation because they consume syncWebApp's output directory directly.
 */
tasks.named("preBuild").configure {
    dependsOn(syncWebApp)
}

tasks.matching {
    it.name.endsWith("Assets") || it.name.contains("Lint")
}.configureEach {
    dependsOn(syncWebApp)
}