# LiteRT-LM's native code finds these classes and callbacks by name; R8 renaming them aborts the app.
-keep class com.google.ai.edge.litertlm.** { *; }
