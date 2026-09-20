import ctypes
from ctypes import wintypes
from PIL import ImageGrab

user32 = ctypes.windll.user32
user32.SetProcessDPIAware()

hwnd = user32.FindWindowW(None, "One Harness")
print("hwnd =", hwnd)
if not hwnd:
    raise SystemExit("没找到窗口")

user32.ShowWindow(hwnd, 9)
user32.SetForegroundWindow(hwnd)
import time; time.sleep(1.0)

r = wintypes.RECT()
user32.GetWindowRect(hwnd, ctypes.byref(r))
w, h = r.right - r.left, r.bottom - r.top
print("窗口矩形: %d,%d %dx%d" % (r.left, r.top, w, h))

im = ImageGrab.grab(bbox=(r.left, r.top, r.right, r.bottom))
out = "lo-recon/shots-0.1.13-app.png"
im.save(out)
print("已保存", out, im.size)
