#pragma once
#include <windows.h>
#include <algorithm>
#include <array>
#include <cmath>

struct BackgroundSample { bool ok=false, light=true; double luminance=1.0; };

// Read a tiny copy of the underlying desktop, excluding layered overlays. No
// full-screen capture, PNG encoding, title inspection or network is involved.
inline BackgroundSample sampleBackground(RECT rect, bool previousLight=true) {
  BackgroundSample result; result.light=previousLight;
  const long long width=static_cast<long long>(rect.right)-rect.left;
  const long long height=static_cast<long long>(rect.bottom)-rect.top;
  if(width<1||height<1||width>32768||height>32768) return result;
  constexpr int columns=20, rows=12;
  HDC screen=GetDC(nullptr); if(!screen) return result;
  HDC memory=CreateCompatibleDC(screen);
  BITMAPINFO info{}; info.bmiHeader.biSize=sizeof(BITMAPINFOHEADER);
  info.bmiHeader.biWidth=columns; info.bmiHeader.biHeight=-rows;
  info.bmiHeader.biPlanes=1; info.bmiHeader.biBitCount=32; info.bmiHeader.biCompression=BI_RGB;
  void* data=nullptr;
  HBITMAP bitmap=memory?CreateDIBSection(screen,&info,DIB_RGB_COLORS,&data,nullptr,0):nullptr;
  if(bitmap) {
    HGDIOBJ previous=SelectObject(memory,bitmap);
    SetStretchBltMode(memory,COLORONCOLOR);
    if(StretchBlt(memory,0,0,columns,rows,screen,rect.left,rect.top,static_cast<int>(width),static_cast<int>(height),SRCCOPY)) {
      GdiFlush();
      const auto* pixels=static_cast<const unsigned char*>(data);
      std::array<double,columns*rows> values{};
      const auto linear=[](unsigned char value) {
        const double channel=value/255.0;
        return channel<=0.04045?channel/12.92:std::pow((channel+0.055)/1.055,2.4);
      };
      for(size_t i=0;i<values.size();i++) values[i]=0.2126*linear(pixels[i*4+2])+0.7152*linear(pixels[i*4+1])+0.0722*linear(pixels[i*4]);
      std::nth_element(values.begin(),values.begin()+values.size()/2,values.end());
      result.luminance=values[values.size()/2]; result.ok=true;
      // Hysteresis avoids flicker on textured backgrounds near the crossover.
      result.light=previousLight?result.luminance>=0.17:result.luminance>0.19;
    }
    SelectObject(memory,previous); DeleteObject(bitmap);
  }
  if(memory) DeleteDC(memory); ReleaseDC(nullptr,screen);
  return result;
}
