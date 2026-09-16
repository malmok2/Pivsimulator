# PIV Simulator

브라우저에서 **입자영상유속계(PIV, Particle Image Velocimetry)** 의 계산을 실제로 돌려보는 웹앱입니다.
PIV를 한 번도 접하지 않은 사람도 예제 영상으로 "두 장의 사진에서 유동장이 나오는" 과정을
눈으로 따라갈 수 있고, 전공자는 창 크기·중첩률·패스 수·부화소 피팅을 바꿔가며
오차가 어떻게 변하는지 바로 확인할 수 있습니다.

해석적 유동장으로 입자 영상을 합성하기 때문에 **참값을 알고 있습니다.**
따라서 측정값과 참값의 차이 = 이 방법의 실제 오차이고, 화면에 RMS 오차로 바로 나옵니다.

라이브러리 의존성이 없습니다. 빌드 도구도 필요 없습니다.

---

## 바로 실행

공개 주소: **https://malmok2.github.io/Pivsimulator/**

> 처음 한 번만 저장소 **Settings → Pages → Source** 를 **GitHub Actions** 로 바꿔 주세요.
> 그러면 `.github/workflows/pages.yml` 이 푸시마다 엔진 검증을 돌리고, 통과하면
> 저장소 루트를 그대로 공개합니다(루트에 `index.html` 이 있어 빌드 단계가 없습니다).
> Pages 사이트를 만드는 권한은 워크플로 토큰에 없어서 이 한 번은 사람이 켜야 합니다.
> 켜기 전까지 워크플로는 실패하지 않고 안내만 남깁니다.

내려받아 실행하려면:

```
git clone https://github.com/malmok2/Pivsimulator.git
cd Pivsimulator
open index.html            # 파일을 그대로 열어도 동작합니다 (file:// 가능)
```

또는 `dist/piv-simulator.html` 한 파일만 열어도 동일하게 동작합니다.

## Think_webpage에 붙이기

**방법 1 — 단일 파일 (가장 간단)**

`dist/piv-simulator.html` 하나만 사이트에 올리고 iframe으로 감싸면 끝입니다.

```html
<iframe src="/piv/piv-simulator.html"
        title="PIV Simulator"
        loading="lazy"
        style="width:100%;height:2400px;border:0"></iframe>
```

**방법 2 — 원본 파일 복사**

`index.html`, `css/`, `js/` 를 사이트 하위 디렉터리에 그대로 복사합니다.
페이지 스타일을 사이트에 맞추려면 `css/piv.css` 위쪽의 색 토큰(`:root`)만 바꾸면 됩니다.

단일 파일은 원본에서 자동 생성됩니다.

```
node tools/build.js     # dist/piv-simulator.html, dist/artifact.html 갱신
node tests/engine.test.js   # 엔진 정확도 검증
```

---

## 화면 구성

| 영역 | 하는 일 |
|---|---|
| 4단계 카드 | 씨딩 → 이중 노출 → 상호상관 → 속도장. 누르면 그 단계의 화면으로 바뀝니다 |
| 유동 / 촬영 조건 | 유동 종류 10가지, 입자 변위, 창당 입자 수, 입자상 지름, 노이즈, 면외 손실 |
| 계산 조건 | 조사창 16/32/64 px, 중첩률 0~75 %, 패스 1~3, 부화소 피팅 3종, 이상치 문턱값 |
| 스테이지 | 입자영상 A / A↔B 반짝임 / 겹쳐보기 / 속도 크기 / 와도 / 오차 / 발산 + 벡터·참값·격자 겹쳐 그리기 |
| 상관 현미경 | 클릭한 조사창의 창 A, 창 B, 상관면 R(Δx,Δy)를 입체/평면으로. 측정값·참값·오차·SNR까지 |
| 측정 상태 점검 | 창당 입자 수, 1/4 규칙, 입자상 지름, 피크 비, 유효 벡터율을 통과/주의로 표시 |

실제 PIV 영상 두 장을 올려서 같은 엔진으로 처리할 수도 있습니다(참값이 없으므로 오차 대신 상관 신호만 표시).
벡터장은 CSV로 복사할 수 있습니다.

## 엔진이 실제로 하는 계산

**영상 합성** (`js/synth.js`, `js/flow.js`)
가우스 강도 분포를 가진 입자 `I = I₀ exp(−8r²/dτ²)` 를 해석적 유동장을 따라 RK4로 이동시켜
두 프레임을 만듭니다. 레이저 시트 두께에 따른 밝기 변화, 8비트 양자화, 읽기 노이즈,
면외 손실(짝을 잃은 입자)까지 포함합니다. 난수는 시드를 쓰므로 재현됩니다.

**상호상관** (`js/piv.js`, `js/fft.js`)
창의 평균을 뺀 뒤 `R = IFFT(conj(FFT(A))·FFT(B))` 로 상관면을 얻고 fftshift 후 정규화합니다
(값은 상관계수 −1~1). 피크 주변 3점에 가우스를 맞춰 부화소 변위를 구합니다.
다중 패스에서는 앞 패스의 결과만큼 두 창을 **대칭으로** 밀고 잔여 변위만 다시 찾습니다.
예측자는 마스크 구멍을 메우고 3×3 평활을 거칩니다.

**검증**
1차/2차 피크 비(SNR)와 상관 피크 값으로 신호 부족을 걸러내고,
보편 중앙값 검정(universal median test)으로 이상치를 찾아 이웃 중앙값으로 대체합니다.
경계 벡터는 이웃이 한쪽으로만 있으므로 문턱값을 완화합니다(그렇지 않으면 속도 기울기가
전부 이상치로 판정됩니다).

**유도량**
와도와 발산은 벡터 격자에서 중앙차분으로 계산하되, 영상 경계와 물체 벽 옆에서는
한쪽 차분을 씁니다. 물체에 20 % 이상 걸친 조사창은 계산에서 제외합니다.

## 검증 결과

`node tests/engine.test.js` 가 확인하는 것 (256×256, 창 32 px, 중첩 50 %, N_I = 14, 노이즈 1.5 %):

- 균일 유동 RMS 오차 **0.04~0.06 px** — 센서 픽셀의 1/20 수준
- 유동장 10종 모두 RMS < 0.25·Δx, 탈락 벡터 < 8 %
- 큰 변위(14 px)에서 다중 패스가 단일 패스보다 개선
- 입자가 적으면(N_I = 1.5) 오차 증가, 면외 손실 50 %에서 상관 피크 0.85 → 0.43
- 무게중심 피팅은 가우스 피팅보다 오차 큼(peak locking)
- 강체 회전의 와도가 해석값 2·sin Ω 와 **5 % 이내** 일치, 발산은 그 25 % 미만
- 조사창을 32 → 16 px로 줄이면 와동 코어의 오차 감소(공간 분해능)
- 384×384, 3패스, 50 % 중첩 = 529 벡터에 약 150 ms

## 한계

단일 상관이고 창 변형(window deformation)이 없으며 2성분(2D2C)만 다룹니다.
상용 PIV 코드의 창 변형·가중·앙상블 상관, 스테레오/토모그래피는 포함하지 않았습니다.
합성 영상의 강한 기울기 영역(와동 코어, 전단층)에서 남는 오차는 버그가 아니라
조사창이 그 안의 변위를 평균해서 생기는 **공간 분해능 오차**입니다 — 창을 줄이면 줄어듭니다.

## 파일

```
index.html          문서 구조 (문구는 전부 data-i18n 키)
icon.svg            도구 아이콘 (THINKLAB 홈페이지 도구 목록이 이 주소를 읽습니다)
css/piv.css         색 토큰 · 레이아웃 (라이트/다크)
js/fft.js           radix-2 FFT, 정규화 상호상관
js/flow.js          해석적 유동장 10종, RK4 변위
js/synth.js         입자 영상 합성 (센서 모델 포함)
js/piv.js           다중 패스 PIV, 부화소 피팅, 검증, 와도/발산, 참값 비교
js/colormap.js      색 램프 (순차 · 발산 · 상관면)
js/render.js        캔버스 그리기 (벡터, 장, 상관면 입체)
js/i18n.js          한국어 / 영어 문구
js/app.js           상태와 배선
tools/build.js      단일 파일 번들러
tests/engine.test.js 엔진 정확도 검증
```

## 참고

- M. Raffel, C. E. Willert, F. Scarano, C. J. Kähler, S. T. Wereley, J. Kompenhans,
  *Particle Image Velocimetry: A Practical Guide*, 3rd ed., Springer.
- J. Westerweel, F. Scarano, "Universal outlier detection for PIV data",
  *Experiments in Fluids* **39** (2005) 1096–1100.

---

### English

A dependency-free PIV simulator that runs the real cross-correlation computation in the
browser. Synthetic particle image pairs are generated from analytic flow fields, so the
exact displacement is known and the measurement can be graded against it — RMS error
reaches about 1/20 of a sensor pixel in well-posed conditions. Click any interrogation
window to see its two windows and the correlation plane. Korean/English toggle in the
top right. Open `index.html`, or embed `dist/piv-simulator.html` as a single file.
