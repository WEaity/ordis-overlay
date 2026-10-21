from PIL import Image
src = Image.open(r"E:\warframe_localhost\overlay-demo\assets\ordis_icon.src.webp").convert("RGBA")
# 生成 256 方形图标（保留原始留白，避免裁掉光晕）
src = src.resize((256, 256), Image.LANCZOS)
src.save(r"E:\warframe_localhost\overlay-demo\assets\icon.ico", sizes=[(16,16),(32,32),(48,48),(64,64),(128,128),(256,256)])
print("ico ok")
