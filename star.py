import cv2
import numpy as np
import pyautogui

template = cv2.imread("star.png", 0)
w, h = template.shape[::-1]

while True:

    # capture screen
    screenshot = pyautogui.screenshot()
    frame = cv2.cvtColor(np.array(screenshot), cv2.COLOR_BGR2GRAY)

    # match template
    result = cv2.matchTemplate(frame, template, cv2.TM_CCOEFF_NORMED)

    threshold = 0.85
    locations = np.where(result >= threshold)

    if len(locations[0]) > 0:
        print("⭐ Star detected!")
        # play sound / send alert here
        break