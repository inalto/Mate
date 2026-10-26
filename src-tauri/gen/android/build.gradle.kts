buildscript {
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath("com.android.tools.build:gradle:9.3.1")
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:2.2.10")
    }
}

allprojects {
    repositories {
        google()
        mavenCentral()
    }
}

// tauri-android requires every module that depends on it to compile against API 36 or later, but
// some plugin libraries (tauri-plugin-sharekit 0.3.1) still say compileSdk = 35, which fails the
// release build's AAR metadata check. Raise them after their own build scripts have run.
subprojects {
    plugins.withId("com.android.library") {
        extensions.configure<com.android.build.api.variant.LibraryAndroidComponentsExtension> {
            finalizeDsl { android ->
                if ((android.compileSdk ?: 0) < 36) {
                    android.compileSdk = 36
                }
            }
        }
    }
}

tasks.register("clean").configure {
    delete("build")
}

