#define UNICODE
#define _UNICODE
#include <windows.h>
#include <algorithm>
#include <iostream>
#include <string>
#include <thread>

namespace {
constexpr UINT UPDATE_TEXT=WM_APP+1, UPDATE_STATUS=WM_APP+2, EXIT_WINDOW=WM_APP+3;
HWND window=nullptr;
DWORD guiThread=0;
std::wstring answer, status=L"原生答题窗 · 正在等待截题";
std::wstring desktopName;
HDESK attachedDesktop=nullptr;
HFONT font=nullptr, smallFont=nullptr;
bool running=true, rebuilding=false, folded=false;
int scrollOffset=0, hoverIndex=-1, hoverMs=1200;
ULONGLONG hoverSince=0;
const wchar_t* labels[]={L"截题",L"加页",L"复制",L"停止",L"上翻",L"下翻",L"收起",L"退出"};
const char* actions[]={"capture","append","copy","stop","up","down","fold","exit"};

std::wstring decode(const std::string& text) {
  static const std::string alphabet="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string bytes; int bits=0, value=0;
  for(unsigned char ch:text) {
    if(ch=='=') break;
    const size_t index=alphabet.find(ch); if(index==std::string::npos) continue;
    value=(value<<6)|static_cast<int>(index); bits+=6;
    if(bits>=8) { bits-=8; bytes.push_back(static_cast<char>((value>>bits)&255)); value&=(1<<bits)-1; }
    if(bytes.size()>256000) break;
  }
  if(bytes.empty()) return {};
  const int count=MultiByteToWideChar(CP_UTF8,0,bytes.data(),static_cast<int>(bytes.size()),nullptr,0);
  std::wstring result(count,L'\0');
  MultiByteToWideChar(CP_UTF8,0,bytes.data(),static_cast<int>(bytes.size()),result.data(),count);
  return result;
}
void emit(const char* event) { std::cout << "{\"event\":\"" << event << "\"}\n" << std::flush; }
void action(int index) {
  if(index==4) scrollOffset=std::max(0,scrollOffset-200);
  else if(index==5) scrollOffset+=200;
  else if(index==6) { folded=!folded; SetWindowPos(window,HWND_TOPMOST,0,0,640,folded?88:460,SWP_NOMOVE|SWP_NOACTIVATE); }
  else if(index==7) PostMessageW(window,WM_CLOSE,0,0);
  else { status=index<2?L"正在截取题目…":status; emit(actions[index]); }
  InvalidateRect(window,nullptr,FALSE);
}
std::wstring inputDesktopName(HDESK desktop) {
  wchar_t name[256]{}; DWORD bytes=sizeof(name);
  return desktop&&GetUserObjectInformationW(desktop,UOI_NAME,name,bytes,&bytes)?name:L"";
}
void paint(HWND hwnd) {
  PAINTSTRUCT paint{}; HDC dc=BeginPaint(hwnd,&paint); RECT client{}; GetClientRect(hwnd,&client);
  HBRUSH background=CreateSolidBrush(RGB(23,28,38)); FillRect(dc,&client,background); DeleteObject(background);
  SetBkMode(dc,TRANSPARENT); SetTextColor(dc,RGB(235,238,245)); SelectObject(dc,smallFont);
  for(int i=0;i<8;i++) {
    RECT rect{8+i*78,8,80+i*78,40};
    HBRUSH brush=CreateSolidBrush(i==hoverIndex?RGB(57,79,115):RGB(39,48,66)); FillRect(dc,&rect,brush); DeleteObject(brush);
    DrawTextW(dc,labels[i],-1,&rect,DT_CENTER|DT_VCENTER|DT_SINGLELINE);
  }
  RECT caption{12,48,client.right-12,80}; SetTextColor(dc,RGB(160,180,210));
  DrawTextW(dc,status.c_str(),static_cast<int>(status.size()),&caption,DT_SINGLELINE|DT_END_ELLIPSIS);
  if(!folded) {
    SelectObject(dc,font); SetTextColor(dc,RGB(235,238,245));
    RECT measured{16,0,std::max(32L,client.right-16),0};
    DrawTextW(dc,answer.c_str(),static_cast<int>(answer.size()),&measured,DT_WORDBREAK|DT_CALCRECT|DT_NOPREFIX);
    scrollOffset=std::clamp(scrollOffset,0,std::max(0,static_cast<int>(measured.bottom-client.bottom+92)));
    IntersectClipRect(dc,12,88,client.right-12,client.bottom-8);
    RECT body{16,88-scrollOffset,client.right-16,88-scrollOffset+measured.bottom};
    DrawTextW(dc,answer.c_str(),static_cast<int>(answer.size()),&body,DT_WORDBREAK|DT_NOPREFIX);
  }
  EndPaint(hwnd,&paint);
}
LRESULT CALLBACK procedure(HWND hwnd,UINT message,WPARAM wParam,LPARAM lParam) {
  switch(message) {
    case WM_MOUSEACTIVATE: return MA_NOACTIVATE;
    case WM_ERASEBKGND: return 1;
    case WM_PAINT: paint(hwnd); return 0;
    case WM_MOUSEWHEEL: scrollOffset=std::max(0,scrollOffset-GET_WHEEL_DELTA_WPARAM(wParam)); InvalidateRect(hwnd,nullptr,FALSE); return 0;
    case WM_LBUTTONUP: {
      POINT point{static_cast<short>(LOWORD(lParam)),static_cast<short>(HIWORD(lParam))};
      if(point.y>=8&&point.y<40&&point.x>=8) { int index=(point.x-8)/78; if(index<8) action(index); }
      return 0;
    }
    case WM_NCHITTEST: {
      POINT point{static_cast<short>(LOWORD(lParam)),static_cast<short>(HIWORD(lParam))}; ScreenToClient(hwnd,&point);
      if(point.y>=42&&point.y<85) return HTCAPTION;
      return HTCLIENT;
    }
    case WM_CLOSE: running=false; DestroyWindow(hwnd); return 0;
    case WM_DESTROY: if(!rebuilding) running=false; return 0;
  }
  return DefWindowProcW(hwnd,message,wParam,lParam);
}
bool createWindow(HINSTANCE instance,RECT previous={}) {
  WNDCLASSW cls{}; cls.lpfnWndProc=procedure; cls.hInstance=instance; cls.lpszClassName=L"IntegratedNativeAnswer";
  cls.hCursor=LoadCursorW(nullptr,IDC_ARROW); RegisterClassW(&cls);
  int x=previous.right?previous.left:std::max(0,GetSystemMetrics(SM_CXSCREEN)-660);
  int y=previous.bottom?previous.top:80;
  window=CreateWindowExW(WS_EX_TOPMOST|WS_EX_TOOLWINDOW|WS_EX_NOACTIVATE|WS_EX_LAYERED,cls.lpszClassName,L"解题助手原生答题窗",WS_POPUP|WS_THICKFRAME,
    x,y,640,folded?88:460,nullptr,nullptr,instance,nullptr);
  if(!window) return false;
  SetLayeredWindowAttributes(window,0,235,LWA_ALPHA);
  SetWindowDisplayAffinity(window,0x11);
  // A hidden console startup can override the first ShowWindow call. Explicitly
  // show our GUI window without activating it, independently of console flags.
  ShowWindow(window,SW_SHOWNOACTIVATE); SetWindowPos(window,HWND_TOPMOST,0,0,0,0,SWP_NOSIZE|SWP_NOMOVE|SWP_NOACTIVATE|SWP_SHOWWINDOW);
  return true;
}
void followDesktop(HINSTANCE instance) {
  HDESK input=OpenInputDesktop(0,FALSE,DESKTOP_READOBJECTS|DESKTOP_CREATEWINDOW|DESKTOP_WRITEOBJECTS);
  const auto name=inputDesktopName(input);
  if(!input||name.empty()||name==desktopName) { if(input) CloseDesktop(input); return; }
  RECT bounds{}; if(window) GetWindowRect(window,&bounds);
  rebuilding=true; if(window) DestroyWindow(window); window=nullptr;
  if(SetThreadDesktop(input)) {
    if(attachedDesktop) CloseDesktop(attachedDesktop);
    attachedDesktop=input; desktopName=name; input=nullptr;
    createWindow(instance,bounds);
  } else createWindow(instance,bounds);
  rebuilding=false; if(input) CloseDesktop(input);
}
}
int wmain(int argc,wchar_t** argv) {
  if(argc>2&&std::wstring(argv[1])==L"--hover-ms") hoverMs=std::clamp(_wtoi(argv[2]),300,6000);
  SetProcessDPIAware(); guiThread=GetCurrentThreadId(); MSG message{}; PeekMessageW(&message,nullptr,WM_USER,WM_USER,PM_NOREMOVE);
  HINSTANCE instance=GetModuleHandleW(nullptr);
  desktopName=inputDesktopName(GetThreadDesktop(guiThread));
  font=CreateFontW(-18,0,0,0,FW_NORMAL,FALSE,FALSE,FALSE,DEFAULT_CHARSET,0,0,CLEARTYPE_QUALITY,0,L"Microsoft YaHei UI");
  smallFont=CreateFontW(-14,0,0,0,FW_NORMAL,FALSE,FALSE,FALSE,DEFAULT_CHARSET,0,0,CLEARTYPE_QUALITY,0,L"Microsoft YaHei UI");
  followDesktop(instance);
  if(!window&&!createWindow(instance)) { emit("error"); return 1; }
  std::thread([] {
    std::string line;
    while(std::getline(std::cin,line)) {
      if(line=="stop") break;
      UINT kind=line.rfind("text ",0)==0?UPDATE_TEXT:line.rfind("status ",0)==0?UPDATE_STATUS:0;
      if(kind) {
        auto* text=new std::wstring(decode(line.substr(line.find(' ')+1)));
        if(!PostThreadMessageW(guiThread,kind,0,reinterpret_cast<LPARAM>(text))) delete text;
      }
    }
    PostThreadMessageW(guiThread,EXIT_WINDOW,0,0);
  }).detach();
  emit("ready");
  ULONGLONG checked=0;
  while(running) {
    while(PeekMessageW(&message,nullptr,0,0,PM_REMOVE)) {
      if(message.message==UPDATE_TEXT||message.message==UPDATE_STATUS) {
        auto* text=reinterpret_cast<std::wstring*>(message.lParam);
        if(message.message==UPDATE_TEXT) { answer=*text; if(answer.empty()) scrollOffset=0; }
        else status=*text;
        delete text; if(window) InvalidateRect(window,nullptr,FALSE);
      } else if(message.message==EXIT_WINDOW) running=false;
      else { TranslateMessage(&message); DispatchMessageW(&message); }
    }
    const auto now=GetTickCount64();
    if(now-checked>=500) { checked=now; followDesktop(instance); if(window) SetWindowPos(window,HWND_TOPMOST,0,0,0,0,SWP_NOSIZE|SWP_NOMOVE|SWP_NOACTIVATE); }
    if(window) {
      POINT cursor{}; GetCursorPos(&cursor); ScreenToClient(window,&cursor);
      int hovered=cursor.y>=8&&cursor.y<40&&cursor.x>=8&&cursor.x<632?(cursor.x-8)/78:-1;
      if(hovered!=hoverIndex) { hoverIndex=hovered; hoverSince=now; InvalidateRect(window,nullptr,FALSE); }
      if(hoverIndex>=0&&hoverSince&&now-hoverSince>=static_cast<ULONGLONG>(hoverMs)) { action(hoverIndex); hoverSince=0; }
    }
    MsgWaitForMultipleObjects(0,nullptr,FALSE,50,QS_ALLINPUT);
  }
  emit("exit"); if(window&&IsWindow(window)) DestroyWindow(window);
  DeleteObject(font); DeleteObject(smallFont);
  // Windows releases the desktop handle after the last GUI thread exits.
  return 0;
}
