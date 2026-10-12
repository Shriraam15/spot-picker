# Spot Picker does not currently enable minification, so no rules are required.
# The @JavascriptInterface methods are kept explicitly in case R8 is turned on
# later, since they are only ever called from JavaScript.
-keepclassmembers class com.spotpicker.app.SpotPickerBridge {
    @android.webkit.JavascriptInterface <methods>;
}