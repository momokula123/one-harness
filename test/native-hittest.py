# 直接问窗口："这个点在你这里算什么区域？" —— SendMessage(WM_NCHITTEST) 的返回值就是答案。
# 1=HTCLIENT(正常客户区) 2=HTCAPTION(拖拽区/标题区) 12-17=上/左右/下边框(缩放) 0=HTNOWHERE …
# 这是 OS 层的命中测试，CDP / sendInputEvent 都绕过了它，而真鼠标必须过它。
# 用法: python test/native-hittest.py <pid> [step] [outfile]
import ctypes, sys, json
from ctypes import wintypes
u = ctypes.windll.user32
u.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
u.GetClientRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
u.ClientToScreen.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.POINT)]
u.SendMessageW.argtypes = [wintypes.HWND, ctypes.c_uint, wintypes.WPARAM, wintypes.LPARAM]
u.SendMessageW.restype = ctypes.c_ssize_t

pid = int(sys.argv[1]); step = int(sys.argv[2]) if len(sys.argv) > 2 else 6
out = sys.argv[3] if len(sys.argv) > 3 else None
WM_NCHITTEST = 0x0084
NAMES = {0: 'NOWHERE', 1: 'CLIENT', 2: 'CAPTION', 3: 'SYSMENU', 10: 'LEFT', 11: 'RIGHT',
         12: 'TOP', 13: 'TOPLEFT', 14: 'TOPRIGHT', 15: 'BOTTOM', 16: 'BOTTOMLEFT', 17: 'BOTTOMRIGHT'}

found = []
EP = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
def cb(hwnd, lp):
    wp = wintypes.DWORD(); u.GetWindowThreadProcessId(hwnd, ctypes.byref(wp))
    if wp.value == pid and u.IsWindowVisible(hwnd) and u.GetWindowTextLengthW(hwnd) > 0:
        found.append(hwnd)
    return True
u.EnumWindows(EP(cb), None)
if not found:
    print(json.dumps({'error': 'no window'})); sys.exit(1)
hwnd = found[0]
o = wintypes.POINT(0, 0); u.ClientToScreen(hwnd, ctypes.byref(o))
cr = wintypes.RECT(); u.GetClientRect(hwnd, ctypes.byref(cr))
W, H = cr.right - cr.left, cr.bottom - cr.top

grid, hist, odd = {}, {}, []
for y in range(0, H, step):
    for x in range(0, W, step):
        lp = ((o.y + y) << 16) | ((o.x + x) & 0xFFFF)
        code = int(u.SendMessageW(hwnd, WM_NCHITTEST, 0, lp))
        grid[f'{x},{y}'] = code
        hist[NAMES.get(code, str(code))] = hist.get(NAMES.get(code, str(code)), 0) + 1
        if code != 1:
            odd.append([x, y, code, NAMES.get(code, str(code))])
res = {'client': [o.x, o.y, W, H], 'step': step, 'histogram': hist, 'nonClientCount': len(odd), 'nonClient': odd}
if out:
    json.dump(res, open(out, 'w'), ensure_ascii=False)
print(json.dumps({'histogram': hist, 'nonClientCount': len(odd), 'first20': odd[:20]}, ensure_ascii=False))
