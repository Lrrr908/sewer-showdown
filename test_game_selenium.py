#!/usr/bin/env python3
"""
Test the TMNT Art Show game by loading it in a headless browser
and capturing console logs and screenshots.
"""

import time
import sys

try:
    from selenium import webdriver
    from selenium.webdriver.chrome.options import Options
    from selenium.webdriver.chrome.service import Service
    from selenium.webdriver.common.by import By
    from selenium.webdriver.support.ui import WebDriverWait
    from selenium.webdriver.support import expected_conditions as EC
except ImportError:
    print("ERROR: Selenium not installed")
    print("Install with: pip install selenium")
    sys.exit(1)

def test_game():
    print("Setting up Chrome in headless mode...")
    
    chrome_options = Options()
    chrome_options.add_argument("--headless=new")
    chrome_options.add_argument("--no-sandbox")
    chrome_options.add_argument("--disable-dev-shm-usage")
    chrome_options.add_argument("--disable-gpu")
    chrome_options.add_argument("--window-size=1920,1080")
    
    # Enable browser logging
    chrome_options.set_capability('goog:loggingPrefs', {'browser': 'ALL'})
    
    try:
        driver = webdriver.Chrome(options=chrome_options)
        print("✓ Chrome driver initialized")
        
        print("\nNavigating to http://localhost:8080...")
        driver.get("http://localhost:8080")
        print("✓ Page loaded")
        
        # Wait a bit for the game to initialize
        print("\nWaiting for game to initialize (5 seconds)...")
        time.sleep(5)
        
        # Check if canvas exists
        try:
            canvas = driver.find_element(By.ID, "gameCanvas")
            print("✓ Game canvas found")
            print(f"  Canvas size: {canvas.get_attribute('width')}x{canvas.get_attribute('height')}")
        except:
            print("✗ Game canvas NOT found")
        
        # Get browser console logs
        print("\n" + "="*60)
        print("BROWSER CONSOLE LOGS:")
        print("="*60)
        
        logs = driver.get_log('browser')
        if logs:
            for entry in logs:
                level = entry['level']
                message = entry['message']
                
                # Color code by level
                if level == 'SEVERE':
                    prefix = "❌ ERROR"
                elif level == 'WARNING':
                    prefix = "⚠️  WARN"
                else:
                    prefix = "ℹ️  INFO"
                
                print(f"{prefix}: {message}")
        else:
            print("(No console logs captured)")
        
        # Take a screenshot
        screenshot_path = "/home/beast/tmnt-art-show/test_screenshot.png"
        driver.save_screenshot(screenshot_path)
        print(f"\n✓ Screenshot saved to: {screenshot_path}")
        
        # Check page title
        print(f"\nPage Title: {driver.title}")
        
        # Get page source length
        print(f"Page Source Length: {len(driver.page_source)} characters")
        
        # Try to execute some JavaScript to check game state
        print("\n" + "="*60)
        print("GAME STATE CHECK:")
        print("="*60)
        
        try:
            game_loaded = driver.execute_script("return typeof game !== 'undefined';")
            print(f"✓ Game object exists: {game_loaded}")
            
            if game_loaded:
                sprites_ready = driver.execute_script("return game.spritesReady || false;")
                print(f"  Sprites ready: {sprites_ready}")
                
                mode = driver.execute_script("return game.mode || 'unknown';")
                print(f"  Game mode: {mode}")
                
                player_x = driver.execute_script("return game.player ? game.player.x : null;")
                player_y = driver.execute_script("return game.player ? game.player.y : null;")
                print(f"  Player position: ({player_x}, {player_y})")
                
                canvas_width = driver.execute_script("return game.canvas ? game.canvas.width : null;")
                canvas_height = driver.execute_script("return game.canvas ? game.canvas.height : null;")
                print(f"  Canvas dimensions: {canvas_width}x{canvas_height}")
                
                artist_count = driver.execute_script("return Object.keys(ARTISTS || {}).length;")
                print(f"  Artists loaded: {artist_count}")
                
                building_count = driver.execute_script("return (BUILDINGS || []).length;")
                print(f"  Buildings loaded: {building_count}")
        except Exception as e:
            print(f"✗ Error checking game state: {e}")
        
        print("\n" + "="*60)
        print("TEST SUMMARY")
        print("="*60)
        
        # Count errors and warnings
        error_count = sum(1 for log in logs if log['level'] == 'SEVERE')
        warning_count = sum(1 for log in logs if log['level'] == 'WARNING')
        
        print(f"Console Errors: {error_count}")
        print(f"Console Warnings: {warning_count}")
        
        if error_count == 0:
            print("\n✓ NO ERRORS DETECTED - Game appears to be loading correctly!")
        else:
            print(f"\n✗ {error_count} ERROR(S) FOUND - Check console logs above")
        
        driver.quit()
        print("\n✓ Test complete")
        
    except Exception as e:
        print(f"\n✗ Test failed with exception: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)

if __name__ == "__main__":
    test_game()
